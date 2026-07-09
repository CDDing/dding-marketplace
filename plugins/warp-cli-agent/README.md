# warp-cli-agent

Claude Code가 작업을 끝내거나, 승인을 기다리거나, 입력을 기다릴 때 **Warp 탭에 알림**을 띄운다. 다른 탭이나 다른 앱에서 일하고 있어도 어느 세션이 나를 부르는지 보인다.

Warp 공식 플러그인([`warpdotdev/claude-code-warp`](https://github.com/warpdotdev/claude-code-warp))과 같은 일을 하되, **Windows에서도 동작한다.**

## 왜 따로 만들었나

공식 플러그인은 Windows에서 알림이 뜨지 않는다 ([issue #2](https://github.com/warpdotdev/claude-code-warp/issues/2), 미해결). 훅 스크립트가 POSIX 셸 전제로 짜여 있어서다.

| 공식 플러그인의 의존성 | Windows에서 생기는 일 |
|---|---|
| `/dev/tty`에 직접 쓰기 | 그 장치가 없다. 훅이 실패한다 |
| `jq`로 JSON 조립 | 기본 설치되어 있지 않다 |
| bash 스크립트 | Git Bash가 있어야 한다 |

이 플러그인은 셋 다 안 쓴다.

- `/dev/tty` 대신 **Claude Code의 [`terminalSequence` 훅 출력 필드](https://code.claude.com/docs/en/hooks)** — 훅이 문자열을 반환하면 Claude Code가 대신 터미널에 쓴다. 문서가 도입 이유로 "`/dev/tty`가 없는 Windows"를 직접 언급한다. **Claude Code v2.1.141 이상** 필요.
- `jq` 대신 **Node의 `JSON.stringify`**
- bash 대신 **Node 스크립트 하나**

macOS·Linux·Windows에서 똑같이 동작한다.

## 설치

```bash
/plugin marketplace add CDDing/dding-marketplace
/plugin install warp-cli-agent@dding-marketplace
```

설치 후 **Claude Code를 재시작**한다. 훅은 시작 시점에 로드된다.

> **공식 `warp` 플러그인과 같이 켜지 말 것.** 둘 다 켜면 이벤트가 두 번 발사되어 알림이 중복된다.

## 동작 원리

Warp는 터미널에 흘러오는 **OSC 777 이스케이프 시퀀스**를 지켜본다. 제목이 정확히 `warp://cli-agent`이면 본문의 JSON을 에이전트 이벤트로 해석한다.

```
ESC ] 777 ; notify ; warp://cli-agent ; {"v":1,"agent":"claude","event":"stop",...} BEL
```

훅 6개가 전부 같은 디스패처(`hooks/warp-cli-agent.js`)를 가리키고, stdin으로 들어오는 `hook_event_name`을 보고 분기한다.

| Claude Code 훅 | 프로토콜 이벤트 | Warp가 카드 본문에 쓰는 필드 |
|---|---|---|
| `SessionStart` | `session_start` | — |
| `UserPromptSubmit` | `prompt_submit` | `query` (내 프롬프트) |
| `PostToolUse` | `tool_complete` | — |
| `PermissionRequest` | `permission_request` | `summary` |
| `Notification` (`idle_prompt`) | `idle_prompt` | `summary` |
| `Stop` | `stop` | `query` (**Claude 응답의 첫 줄**) |

모든 페이로드는 6필드 봉투를 공유한다: `v`, `agent`, `event`, `session_id`, `cwd`, `project`.

### 알아둘 것

**카드 제목은 못 바꾼다.** `Task Completed` 같은 문구는 Warp가 `event` 값을 보고 고른다. 프로토콜에 제목 필드가 없다.

**탭 제목도 못 바꾼다.** Warp가 CLI-agent 세션의 탭 이름을 앱 내부에서 관리한다 ([warp#11970](https://github.com/warpdotdev/warp/issues/11970)). 훅이 보낸 OSC 2는 무시된다.

**`stop` 카드 본문에는 `query`만 쓰인다.** `response`, `project`, 그 외 어떤 필드를 넣어도 카드에 나타나지 않는다. 그래서 이 플러그인은 Claude 응답의 첫 줄을 `query`에 담는다.

**시퀀스는 하나만 보낼 수 있다.** `terminalSequence`에 OSC 시퀀스를 두 개 이어붙이면 Claude Code가 필드 전체를 버린다. 문서상 허용된 OSC 2를 OSC 777 앞에 붙이면 알림까지 같이 사라진다.

위 네 가지는 문서가 아니라 **실제 Warp에 신호를 쏴서 확인한 것**이다.

## 조용히 아무것도 안 하는 경우

알림 하나 때문에 턴이 깨지면 안 되므로, 아래 상황에서는 아무것도 출력하지 않고 종료한다.

- `WARP_CLI_AGENT_PROTOCOL_VERSION`이 없다 (Warp가 아니거나, 이 프로토콜을 모르는 Warp)
- `stop_hook_active`가 참이다 (중복 발사 방지)
- 처리 대상이 아닌 이벤트다
- stdin이 깨졌거나 예외가 났다

## 요구사항

- **Claude Code v2.1.141 이상** — `terminalSequence` 훅 출력 필드
- **Warp** — `WARP_CLI_AGENT_PROTOCOL_VERSION` 환경변수를 세팅하는 버전
- **`node`가 PATH에 있을 것** — 외부 패키지는 쓰지 않는다

## 테스트

```bash
node plugins/warp-cli-agent/test/run-tests.js
```

훅에 이벤트별 샘플 stdin을 먹이고, 나온 시퀀스의 형식과 페이로드를 검사한다. 한글이 왕복해서 안 깨지는지, 응답에 섞인 제어문자(ESC·BEL)가 이스케이프되어 시퀀스를 조기 종료시키지 않는지도 확인한다.
