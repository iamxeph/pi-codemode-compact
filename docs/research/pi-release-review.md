# Pi 릴리스 변경과 pi-codemode-compact 영향 검토

## 후속 구현

아래 내용은 `7e7b0ae` 시점의 최초 조사 기록이다. 후속 작업에서 권장한 다섯 항목을 모두 반영했다:

- 실제 `render(width)`에 맞춘 한 줄 요약과 resize·Unicode·ANSI 검사.
- 완료 시간 `context.durationMs` 우선, 이전 헤더 fallback 유지.
- 개발 SDK 1.2.0 갱신 및 실제 TUI·Pi host·HTML export 회귀 검사.
- 같은 요약 행에 live elapsed 표시, 종료·취소·세션 변경·reload 타이머 정리.
- 이미지 개수 표시, Pi의 기존 이미지 렌더링은 유지.

공식 [Pi 패키지 지침][packages]에 따라 host-provided 패키지의 peer 범위는 `"*"`로 선언한다. Pi는 실행 중인 host 모듈을 확장에 제공하며 managed install에서 peer resolution을 끈다. peer 범위는 런타임 버전 gate가 아니다. 필요한 `registerToolRenderer()` API가 Pi 1.0.1에서 도입됐다는 사실은 README에 별도로 명시한다.

개발 SDK는 1.2.0이다. 최소 버전 전용 CI와 sibling package 강제 고정은 제거하고, 실제 Pi 로더로 확장을 읽고 렌더링하는 검사 및 TUI·이미지·HTML 회귀 검사를 유지한다. 개발 테스트에서 발견한 Pi 1.0.1/최신 sibling 혼합 문제를 Pi 확장 로더의 런타임 실패 증거로 해석해서는 안 된다.

## 범위와 결론

- 확인 대상: [Pi releases](https://github.com/earendil-works/pi/releases)의 최신 표시 버전 **v1.2.0**, 그리고 현재 최소 지원 버전 v1.0.1 이후의 변경.
- 프로젝트 기준: `7e7b0ae` (`feat: use pi.registerToolRenderer for codemode renderers (#6)`).
- 실행 검증: 프로젝트 lockfile의 Pi SDK **1.0.1**에서 기존 테스트 42개와 타입 검사 통과. 실제 `Text`를 사용한 별도 진단도 실행했다.
- 최신 버전 검증 범위: v1.2.0 공식 소스와 계약을 대조했다. **v1.2.0 전체 런타임 통합 테스트는 하지 않았다.**
- 조사만 수행했으며 확장 구현, 테스트, 의존성은 수정하지 않았다.

**판단:** 검토한 변경에서는 확장을 즉시 깨뜨리는 API 삭제·변경이 발견되지 않았다. 기존 공식 renderer resolver 방식은 유지하면 된다. 우선순위는 실제 렌더링 폭 수정 → 기록된 실행 시간 사용 → 최신 출력 회귀 검사 → 선택적인 실시간 경과 시간이다.

## 1. 실제 렌더링 폭을 사용해야 함 — 우선 수정

**관련 upstream:** v1.1.0은 `outputPad`를 renderer context에 추가하고 도구 출력에 적용한다. Pi TUI 계약은 컴포넌트가 실제로 전달받은 폭 안에서 렌더링할 것을 요구한다. [릴리스][r110], [context][types], [TUI 문서][tui], [호스트 컴포넌트][host]

**현재 코드:** `index.ts:141`, `:379`, `:402`는 `process.stdout.columns`를 기준으로 문자열을 미리 줄인다. 이후 `Text.render(width)`에는 이보다 좁은 영역이 전달될 수 있다. `MIN_SUMMARY = 24`도 매우 좁은 화면의 실제 폭보다 클 수 있다.

**재현:** stdout 폭을 80으로 설정하고 실제 `Text.render(40)`을 호출하자 긴 도구 이름이 들어간 collapsed call이 **3행**으로 접혔다. 기존 테스트의 `Text` stub은 전달받은 폭을 무시하고, 폭 검사는 주로 문자열 길이를 비교하므로 이 문제를 놓친다. 이는 v1.1.0에서 새로 발생했다고 단정할 수 없는 기존 레이아웃 결함이며, 가변 padding이 중요성을 높인다.

**권장:** collapsed 요약은 실제 `render(width)` 시점의 폭과 제목·구분자·라인 수·시간 등의 전체 길이를 기준으로 자른다. expanded 출력은 기존처럼 펼친다. real `Text` 또는 실제 컴포넌트를 쓰는 작은 레이아웃 검사 하나를 추가한다.

**주의:** 기본 shell의 `outputPad`는 Pi의 `Box`가 이미 적용한다. 확장에서 padding을 한 번 더 넣으면 안 된다. 다른 resolver가 `renderShell: "self"`를 공급하는 경우에만 그 shell 계약을 별도로 고려한다. [호스트 컴포넌트][host]

## 2. 완료 시간은 `context.durationMs` 우선 — 작은 개선

**관련 upstream:** v1.1.0은 최종 실행 시간을 `ToolRenderContext.durationMs`로 제공한다. v1.2.0 기본 codemode renderer도 이 값을 사용하는 시간 표시를 추가했다. 값은 실행 중, 실행하지 않은 결과, 오래된 세션에서는 없을 수 있다. [릴리스][r110], [context][types], [기본 렌더러][renderer], [시간 helper][utils]

**현재 코드:** `splitScriptOutput()`은 모델-facing 문자열의 `Wall time ... seconds`를 파싱하고 `renderResult()`는 이 값만 쓴다. 성공 요약에는 시간이 들어가지만 실패 요약은 시간을 표시하지 않는다.

**권장:** 최종 결과에서는 `context.durationMs / 1000`을 먼저 사용하고, 없으면 현재 헤더의 `wallTime`으로 fallback한다. 기록된 전체 도구 실행 시간과 codemode 헤더가 잰 구간은 동일한 정의가 아닐 수 있으므로 UI를 기록된 실행 시간으로 통일한다. 오래된 세션·HTML export에서는 fallback을 유지한다. v1.2.0 HTML renderer는 `durationMs: undefined`를 전달한다. [HTML 렌더러][html]

**진단:** `durationMs: 2500`과 헤더 없는 결과를 전달해도 현재 출력은 `✓ done · 1 line`이며 2.5초가 표시되지 않는다. 이는 강제 호환성 수정이 아니라 새 공식 필드 활용이다.

최소 runtime 지원을 1.0.1로 유지하려면 새 필드가 없을 때도 동작해야 한다. 새 타입을 쓰기 위한 devDependency 업데이트와 사용자에게 요구하는 peerDependency 최소 버전 상향은 별개다.

## 3. 실시간 elapsed 표시 — 선택 기능

**관련 upstream:** v1.2.0 codemode 행은 실행 중 경과 시간과 완료 후 총시간을 표시한다. 실행기는 첫 nested call 전에도 빈 partial update를 발행하도록 바뀌었다. [릴리스][r120], [실행기][execute], [기본 렌더러][renderer]

**현재 코드:** `runningLine()`은 활성 도구와 총 호출 수만 표시한다. nested call이 없는 긴 스크립트는 빈 partial update에서 `…`만 표시한다. 최종 시간은 이미 헤더에서 표시하므로 완료 시간 기능 전체가 빠진 것은 아니다.

**권장 UI:** `… bash · 2 calls · 4.2s`처럼 현재 행에 시간을 덧붙인다. 별도 행을 추가해서 compact 목적을 훼손하지 않는다.

**구현 시 제약:** `context.durationMs`는 실행 중에는 없으므로 live clock이 필요하다. `context.state`, `executionStarted`, `invalidate()`를 활용하고, 완료·취소·reload에서 타이머를 정리하며 HTML export에서는 타이머가 시작되지 않게 해야 한다. upstream의 `startToolTimer`/`toolTimerText`는 내부 모듈에 있고 패키지 root에서 export되지 않으므로 내부 경로를 import하는 방식은 피한다. [시간 helper][utils], [공개 exports][exports]

폭 수정과 완료 시간 fallback보다 비용이 큰 선택 기능이다.

## 4. 새 출력 형식과 이미지는 회귀 검사 위주

### v1.1.0 텍스트·console 경계

여러 `text()` 출력에는 `==> text N/M <==` 경계가 생기고 console 출력은 `<console_output>` 블록에 모인다. [릴리스][r110], [출력 처리][execute]

현재 `splitScriptOutput()`은 이 텍스트를 보존하며 시간 헤더도 정상적으로 분리한다. 형식을 읽지 못하는 호환성 버그는 재현되지 않았다. 다만 `countLines()`는 경계·console wrapper까지 포함한 비어 있지 않은 줄을 센다.

**권장:** 실제 새 형식의 regression case를 기존 테스트에 추가한다. 사용자가 출력한 문자열과 경계를 휴리스틱으로 제거하는 것은 피한다. 표시되는 `lines`가 payload만의 줄 수인지 출력 전체의 줄 수인지 필요하면 문서에서 명확히 한다.

### v1.0.3 / v1.0.4 이미지

v1.0.3은 `image()`를 파일에 저장하고 결과에 경로를 붙인다. v1.0.4는 `tools.read()`가 이미지 블록을 돌려주게 고쳤다. v1.1.0은 classifier 입력 이미지도 지원한다. [v1.0.3][r103], [v1.0.4][r104], [v1.1.0][r110]

**중요:** 확장의 `renderResult()`가 텍스트만 요약한다고 이미지 자체가 사라지는 것은 아니다. Pi 호스트가 결과의 이미지 블록을 따로 렌더링하고 `showImages`를 적용한다. 따라서 확장 안에서 `Image` 컴포넌트를 중복 구현할 필요는 없다. 저장된 경로 텍스트도 expanded view에 남는다. [실행기][execute], [호스트 컴포넌트][host]

**선택 개선:** 요약에 `1 image` 등을 넣으면 결과에 이미지가 있다는 사실이 명확해진다. 현재 이미지 블록만 전달하면 `✓ done`으로 표시된다. 실제 최신 built-in 출력에는 저장 경로 텍스트가 붙을 수 있으므로 이 진단을 일반적인 이미지 출력이 항상 `✓ done`이라는 뜻으로 해석하면 안 된다.

이미지·텍스트 혼합, `showImages` on/off, 저장 실패 안내와 HTML export를 host-level smoke test로 확인하는 편이 중복 renderer 구현보다 낫다.

## 5. SDK 및 CI 검증 — 최신 지원을 확인할 때 권장

현재 lockfile과 설치된 개발 SDK는 1.0.1이고 `pnpm test`는 Pi agent와 TUI import를 stub으로 바꾼다. 기존 타입 검사는 유용하지만 최신 버전의 실제 줄바꿈·padding·호스트 이미지 렌더링까지 증명하지 않는다. 근거: `package.json`, `pnpm-lock.yaml`, `tests/hooks.mjs`, `tests/pi-tui-stub.mjs`, `.github/workflows/ci.yml`.

**권장:** 새 필드를 도입하는 작업에 맞춰 개발 SDK를 업데이트하고, 최소 지원 버전 및 최신 버전에서 작은 renderer smoke check를 수행한다. 기존 stub 단위 테스트는 빠른 pure-logic 검사용으로 유지한다. 이를 위해 새로운 테스트 프레임워크나 광범위한 CI matrix를 만들 필요는 없다.

## 변경할 필요 없는 항목

- **v1.0.1 `registerToolRenderer`:** 이미 PR #6에서 반영됐으며 `next()`를 보존하고 codemode만 override한다. 이전 Proxy 재등록 방식으로 돌아갈 이유가 없다. [릴리스][r101], [확장 문서][extensions]
- **v1.2.0 `reachesTools`, namespace aliases, 입력 제약 declarations, MCP 결과 타입:** 도구 정의·탐색·실행 계층이 소유한다. 현재 확장은 그 계층을 재등록하지 않으므로 정상적인 built-in codemode 사용에서 upstream 변경을 그대로 받는다. [릴리스][r120], [codemode 정의][tool]
- **sandbox, 잘못 배치한 options line, 많은 출력의 성능, node --watch 수정:** Pi 업데이트로 받는 실행기 수정이다. renderer에서 재구현하지 않는다. [릴리스][r120]
- **provider / OAuth / configuration schema / `before_agent_start` breaking changes:** 현재 확장은 관련 API나 테마 JSON을 정의하지 않는다. 이번 조사에서 직접 수정할 지점은 찾지 못했다. [릴리스][r120], `index.ts`

## 추천 작업 순서

1. 실제 렌더링 폭에 맞춘 한 줄 요약 + real TUI 레이아웃 검사.
2. 완료 시간 `durationMs` 우선, 헤더 fallback 유지.
3. 최신 text/console 형식과 이미지 혼합 회귀 검사, 개발 SDK 갱신.
4. 필요하면 실시간 elapsed를 같은 요약 행에 추가.
5. 이미지 개수 표시는 별도 선택 사항.

## 폭 문제의 작은 재현 명령

프로젝트 루트에서 실행한다. 별도 설치 없이 현재 개발 의존성을 사용하며, stub loader를 넣지 않는다. 아래 진단은 최초 조사 당시 3행을 출력했다. 후속 수정 후에는 1행을 출력하며, 같은 조건이 실제 TUI 회귀 검사에도 포함돼 있다.

```bash
node --experimental-strip-types --input-type=module <<'JS'
import { renderCall } from './index.ts';
const theme = { fg: (_, text) => text, bold: text => text };
const context = { argsComplete: true, expanded: false, state: {} };
const oldColumns = process.stdout.columns;
Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
try {
  const name = 'mcp__' + 'x'.repeat(100);
  const component = renderCall(
    { code: `await tools.${name}({});\ntext(1);` },
    theme, context, new Set([name]),
  );
  const lines = component.render(40);
  console.log({ rows: lines.length, lines });
} finally {
  Object.defineProperty(process.stdout, 'columns', {
    value: oldColumns, configurable: true,
  });
}
JS
```

## 공식 출처

[packages]: https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/packages.md#declare-dependencies
[r101]: https://github.com/earendil-works/pi/releases/tag/v1.0.1
[r103]: https://github.com/earendil-works/pi/releases/tag/v1.0.3
[r104]: https://github.com/earendil-works/pi/releases/tag/v1.0.4
[r110]: https://github.com/earendil-works/pi/releases/tag/v1.1.0
[r120]: https://github.com/earendil-works/pi/releases/tag/v1.2.0
[types]: https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/extensions/types.ts#L467-L499
[tui]: https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/tui.md
[extensions]: https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md#tool-rendering
[host]: https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/modes/interactive/components/tool-execution.ts
[renderer]: https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/extensions/codemode/renderer.ts
[execute]: https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/extensions/codemode/execute.ts
[tool]: https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/extensions/codemode/tool.ts
[utils]: https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/tools/render-utils.ts#L112-L153
[exports]: https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/index.ts
[html]: https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/export-html/tool-renderer.ts
