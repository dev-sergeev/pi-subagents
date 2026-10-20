# Проверка совместимости с GigaChat

Реализация [спецификации](../../docs/gigachat-compatibility-spec.md) использует **Pi 0.85.1 + неизменённый pi-gigachat 0.6.4**. Все четыре SDK-пакета закреплены на `0.85.1`, TypeBox — на `1.3.7`. Адаптера транскрипта, отдельного режима совместимости и миграции провайдера нет.

Официальный валидатор принял **35 итоговых provider-path объявлений из 13 сценариев**, правила `1.0.6`: HTTP 200, `Function is valid`, без `errors`, только два известных предупреждения. Итоги живого выполнения и локальных команд отделены от валидации схем.

## Доказательства текущей связки

| Артефакт | Что подтверждает | Граница |
| --- | --- | --- |
| [`evidence/provider-pinned0851-final/manifest.json`](evidence/provider-pinned0851-final/manifest.json) и `functions/` | Итоговые функции после регистрации Pi и сериализации настоящим GigaChat-провайдером, включая порядок `replyTo` перед `replyText`. Охвачены активация, обычный/structured workflow, fanout, native child, Herdr, watchdog, обёрнутый bash и четыре structured-output обёртки. | Коллектор останавливает chat-запрос до inference; ответ модели не подделывается. |
| [`evidence/official-validator-pinned0851-final/summary.json`](evidence/official-validator-pinned0851-final/summary.json) | Все 35 финальных функций приняты официальным API. Сохранены точные схемы, SHA-256, полные ответы и версия правил. | Валидность объявления не доказывает его выполнение. |
| [`evidence/acceptance-pinned0851.json`](evidence/acceptance-pinned0851.json) | Сводка шести live-сценариев `GigaChat-3-Ultra` со ссылками на фактические трассы, аргументы, результаты и критерии каждого сценария. | Успешность определяется сохранёнными фактами, не только HTTP-статусом или текстом ответа. |
| [`evidence/local-verification.json`](evidence/local-verification.json) | Команды и результаты для Pi 0.85.1; прежний прогон Pi 0.87.0 сохранён отдельно как исторический snapshot. | Локальные faux-provider проверки не заменяют live-приёмку. |

В live-сценариях nonce существует только в файле изолированного проекта. Родитель не может прочитать fixture напрямую: файл читает настоящий дочерний агент, а результат должен попасть в успешный последующий HTTP-запрос родительской модели и её финальный ответ. Проверяются:

- одиночный foreground-запуск и динамическая активация;
- файловый workflow через `runs.run`, без подмены прямым запуском;
- настоящий detached run ID, `bg_wait` и опубликованный результат;
- `need_decision`, реальный pending ID, успешный ответ supervisor и продолжение ребёнка;
- вызов настоящего `structured_output` и проверенная nonce-only схема профиля;
- чтение fixture watchdog, настоящий `watchdog_warn` и следующий успешный запрос с его результатом.

Трассы содержат реальные события Pi, дочерние session-файлы, безопасные проекции HTTP payload и наблюдённое завершение detached-процессов. Herdr проверен как локальная регистрация bridge, не как удалённое выполнение.

## Контракт аргументов

```js
subagent({ workflow: "true" });                  // js workflow блок текущего ответа
subagent({ workflow: "./workflows/review.js" }); // файл относительно cwd
subagent({ workflow: "parallel", args: { tasks: [{ agent: "scout", task: "Review" }] } });
subagent({ agent: "scout", task: "Review", output: "false" });
subagent({ agent: "scout", task: "Review", output: "true" });
subagent({ agent: "scout", task: "Review", output: "./review.md" });
```

Пропуск `workflow` сохраняет одиночный запуск/management; пропуск `output` сохраняет наследование. Булевы модельные формы отклоняются до преобразования типов Pi. Внутренние workflow/configuration-объекты сохраняют своё представление. Пользовательская схема structured output не ослабляется и не мутируется.

Ответ родительского supervisor использует одобренный отдельный контракт:

```js
subagent_supervisor({ action: "reply", replyTo: actualRequestId, replyText: "Use the authorized option." });
```

Алиаса `message` у этого инструмента нет. Детский `contact_supervisor.message` и внутренние записи остаются прежними; `pending`/`status`/`list` не требуют текста. [Минимальные живые пробы](evidence/supervisor-argument-generation-pinned0851.json) отделяют подтверждённый пропуск optional `message` от исполнения диалога; обе контрольные альтернативы генерировали текст, выбран `replyText`.

В объявлении сохранён порядок `action`, `to`, `replyTo`, `replyText`: текст следует за адресатом. На реальном пути обратный порядок приводил к пропуску текста даже после уточнения; целевой порядок прошёл полный диалог с одного пользовательского запроса. Исходная схема и все неудачные попытки сохранены, а проверка исполнения отделена от официальной валидации.

Новый SDK не поддерживается этим форком. История с чужими `system`, `toolsAdded`, `toolsRemoved` или `sections` требует `/new`; перезапуск и `/reload` её не исправляют. Старый механизм declaration pinning удалён. На Pi 0.85.1 используется собственный system prompt/tools и поддерживаемая очередь `agent_end`/follow-up. Fork сохраняет историю и cache key, но не обещает точное воспроизведение system/tool cache prefix новых Pi.

## Воспроизведение

Используйте Node 24 и закреплённые зависимости проекта. Настройте изолированное подключение через `/gigachat`; `--model` должен соответствовать реально зарегистрированной модели. Не передавайте ключ или токен в аргументах команды и не используйте обычную пользовательскую историю.

### Сбор итоговых объявлений

```sh
node --experimental-strip-types examples/gigachat-compatibility/collect.mjs \
  --provider /absolute/path/to/pi-gigachat/extension.js \
  --model provider/GigaChat-3-Ultra \
  --agent-dir /absolute/path/to/private-agent-dir \
  --out /private/new/provider-evidence
```

Коллектор загружает default extension провайдера и перехватывает поддерживаемый `fetch` на границе сериализованного POST `/chat/completions`. Реальный OAuth refresh при необходимости обращается к endpoint авторизации. Каталог результата должен быть новым.

Диагностика без провайдера:

```sh
node --experimental-strip-types examples/gigachat-compatibility/collect.mjs \
  --sdk-only --out /private/new/sdk-evidence
```

### Официальная валидация

```sh
NODE_EXTRA_CA_CERTS=/absolute/path/to/trusted-ca-bundle.pem \
node examples/gigachat-compatibility/validate.mjs \
  --input /private/new/provider-evidence \
  --out /private/new/validation-evidence \
  --provider /absolute/path/to/pi-gigachat/extension.js \
  --model provider/GigaChat-3-Ultra \
  --agent-dir /absolute/path/to/private-agent-dir
```

Вместо разрешения сохранённой авторизации можно использовать `GIGACHAT_ACCESS_TOKEN` или переменную, указанную `--token-env`. Для SDK-only артефактов нужен `--allow-sdk-only`; это не превращает их в provider-path acceptance. Без авторизации сохраняется настоящий отказ.

Успех требует HTTP success, точного `Function is valid`, отсутствия ошибок, версии правил и только подтверждённых пар предупреждений:

- `#/properties/return_parameters` — `Value is null but should be object`;
- `#/properties/few_shot_examples` — `Value is null but should be array`.

Неизвестное предупреждение, другая причина, HTTP 200 с ошибками или отсутствие версии правил приводят к неуспеху CLI. [API валидатора](https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/function-validation.md), [сертификаты](https://developers.sber.ru/docs/ru/gigachat/certificates).

### Живые сценарии

```sh
NODE_EXTRA_CA_CERTS=/absolute/path/to/trusted-ca-bundle.pem \
GIGACHAT_MAX_RETRIES=8 GIGACHAT_RETRY_BASE_DELAY_MS=2000 \
node --experimental-strip-types examples/gigachat-compatibility/smoke.mjs \
  --provider /absolute/path/to/pi-gigachat/extension.js \
  --model provider/GigaChat-3-Ultra \
  --agent-dir /absolute/path/to/private-agent-dir \
  --out /private/new/live-evidence
```

Опциональный `--scenario` принимает имена через запятую: `single-agent,workflow-file,async,supervisor,structured-output,watchdog`. Не подключайте тестовый loader: он подменяет часть SDK. Скрипт использует настоящий SDK и провайдер без сетевого эмулятора. Настройки retries принадлежат существующему провайдеру, не новой логике pi-subagents; безлимит токенов не отменяет HTTP 429.

Каждый сценарий ограничен десятью минутами. При неуспехе останавливаются только принадлежащие сценарию процессы; удаление runtime-каталога допустимо лишь после проверки их завершения. Не подтверждённый exit сохраняет runtime для диагностики и делает проверку неуспешной.

Стенд допускает одно явно записанное пользовательское уточнение, но не подставляет аргументы в вызов. Для supervisor первый невалидный `reply` прерывает только родительский ход, чтобы уточнение с настоящим ID могло дойти до модели, пока ребёнок ждёт. Повторный пропуск `replyText` после уточнения завершает проверку неуспехом. Это поведение стенда, не автоматическое исправление или retry в pi-subagents; валидный вызов и продолжение ребёнка по-прежнему обязательны.

## История попыток и ограничения

Прежняя несовместимость Pi 0.87.0 с pi-gigachat 0.6.4 сохранена в [`ultra-provider-runtime.json`](evidence/ultra-provider-runtime.json) и [`authenticated-acceptance.json`](evidence/authenticated-acceptance.json). Это исторические результаты, не текущий blocker. `sdk/` и `official-validator-authenticated/` — прежняя SDK-only диагностика; `official-validator/` — первоначальный HTTP 401.

`provider-pinned0851/` и `official-validator-pinned0851/` — успешный предыдущий снимок до переименования; `provider-pinned0851-replytext/` и `official-validator-pinned0851-replytext-final/` — принятые схемы до окончательного упорядочивания свойств. Первая параллельная с inference попытка получила 35 HTTP 429 и сохранена в `official-validator-pinned0851-replytext/`. Текущий финальный снимок выше проверен отдельно от inference. [Условные схемы](evidence/supervisor-conditional-generation-pinned0851.json) проверялись только диагностически; неудачные варианты не внедрены в проект.

Неуспешные живые попытки также сохранены, а не переименованы в успешные: ограничения allowlist стенда, HTTP 429, пропущенные моделью необязательные аргументы, некорректная сериализация JSON в тестовом профиле и timeout первого запроса с high reasoning. Большие сырые трассы сжаты без потерь в `.json.gz`; итоговая сводка указывает точный источник каждого принятого сценария.

Ключ авторизации остаётся вне файлов. Временный bearer хранится только в приватном изолированном профиле с правами `0700`/`0600`, не в репозитории, глобальных настройках или доказательствах. TLS не отключается. Сохраняются только разрешённые поля payload, без headers/auth; артефакты проверяются на известные секреты.

Локальный clean-install smoke подтверждает скомпилированный npm-пакет, раздельную установку Pi 0.85.1, идентичность SDK и настоящий жизненный цикл ребёнка. Он не подтверждает Linux standalone: полный 18-сценарный gate требует Linux x64/bubblewrap и остаётся отдельной CI-проверкой. Общий `npx oxlint .` не заявляется успешным; проверка затронутых compatibility-модулей, CLI и новых поведенческих тестов отделена от старых диагностик всего репозитория.

