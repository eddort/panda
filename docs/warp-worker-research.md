# Честный warp: локальный worker и завершение proposal

2026-09-30. Исследование по закреплённым исходникам и сохранённым результатам; worker и описанные
ниже hooks ещё не реализованы. Новые Docker-прогоны, сборки и тесты для этого документа не
запускались. Цель — каждый из двух последовательных скачков на 8192 слота вместе с первой следующей
транзакцией за ≤60 с, с полной приёмкой из [warp-tdd-acceptance.md](warp-tdd-acceptance.md).

## Выбор кандидата и ограничения

Наиболее компактная композиция: уменьшение повторной криптографической работы, существующий TS
Timeline/Consensus/Automine внутри Docker-сети, прямой BN→EL Engine transport и completion
notification вместо polling. Здесь нет нового native range executor, пропуска переходов состояния,
переноса validator keys или обхода проверок. Достижимость минуты **не доказана**. Direct-sync уже
сократил работу, но сохранённый результат 32 слота / 2956,230 ms соответствует 92,382 ms/slot;
требуется ещё примерно 12,6×.

После ускорения crypto транспорт может стать заметной долей времени. Это гипотеза для композиции, а
не основание повторять длинный прогон без короткого численного gate.

## Размещение runtime без второго владельца времени

Текущие точки: `src/controller.ts:9–151`, `src/api.ts:20–77`, `src/time.ts:30–150`,
`src/automine.ts:33–136`, `src/consensus.ts:19–145`, `src/network.ts:154–296,330–385`.

1. Выделить runtime из Controller: Timeline, Automine, status, time commands, Beacon/RPC forwarding.
   Использовать тот же код и один `Timeline.queue`; host не сохраняет shadow Timeline.
2. Worker entrypoint создаёт runtime с внутренними адресами BN/VC/EL. Host Controller сохраняет
   внешний localhost HTTP, Host/Origin checks, Network lifecycle, shutdown и host resource sampling.
   `Devnet` уже работает через `/control`, поэтому API почти не меняется.
3. Пропускать внешний JSON-RPC через worker тоже. После ответа Geth существующий `Automine.notify()`
   вызывается локально: нет отдельного host→worker wake, потеря которого оставит транзакцию без
   майнинга. Сохранить raw batch/ID/error/notification semantics; RPC-ответ не должен ждать
   майнинга.
4. В Consensus внедрить callback для `skipValidator`, удалив runtime-import конкретного Network.
   Только этот редкий lifecycle callback выполняется на host. Worker удерживает Timeline queue до
   его завершения. Honest advance не обращается к Docker.

Объём по модулям: Controller/runtime, новый worker entrypoint, Network provisioning, Consensus
dependencies; небольшие изменения CLI и profiling. Это ориентир 5–7 production-файлов, не обещание
конкретного количества строк. `cli.ts:138` должен читать authoritative status вместо
`controller.time.timestamp`. `profile.ts:81` сейчас выбирает путь validator keys для любого не-EL/BN
контейнера — новый worker требует отдельной обработки. Docker stats уже находят все контейнеры по
label; `/control resources` сохраняется на host, чтобы не посчитать worker дважды.

Worker создаётся через `Infrastructure.container("worker", ...)` с точным `io.panda.id`, без Docker
socket и без общего bind всей директории `/shared`. Нужны pinned Linux Deno, readonly source bundle,
минимальная конфигурация и отдельный токен внутренних команд. Публичный порт остаётся
localhost-only. Host manifest сохраняет пригодные для host endpoints; worker получает отдельный
набор внутренних URL. Нельзя просто подмонтировать macOS `.tools/deno` в Linux-контейнер.

VC recreation в `network.ts:353` не сохраняет `NetworkingConfig`: требуется стабильное имя
контейнера `panda-<id>-vc` либо alias, установленный и при первоначальном старте, и при замене VC.
Worker не должен продолжать обращаться к старому опубликованному host port.

Shutdown: прекратить admission, остановить Timeline/Automine и дождаться queue, сохраняя EngineGate
доступным, затем убрать owned containers. Worker crash, потеря ответа на advance или частичный
lifecycle callback означают fault/reset; автоматический retry advance и восстановление по одному
равенству BN/VC clocks небезопасны. Равенство clocks не доказывает завершение текущей фазы.

## Engine transport: prerequisite для переноса Timeline

Сейчас `Consensus.move()` синхронно пишет `EngineGate.nowMs`, а gate подавляет будущие payload
attributes (`src/engine.ts:178–183`). Перенос worker без изменения этой связи потребует host hop на
каждой фазе и сохранит существенную часть orchestration.

Предложение: controlled-only проверка future attributes перед фактическим Engine RPC и payload-ID
cache в `beacon_node/execution_layer/src/engines.rs::Engine::notify_forkchoice_updated` (около 161 в
закреплённых деревьях). Сравнивать timestamp с controlled protocol clock, не с wall clock. Обе
execution_layer версии уже зависят от slot_clock. BN основной endpoint — `http://el:8551`;
`HttpJsonRpc::rpc_request` направляет только `engine_getPayloadV*` через существующий host gate.
Gate сохраняет JWT, log-based full-payload readiness и реальные deadlines. Проверка пустого txpool
не заменяет readiness. Это пока proposal; нужны независимые профильные проверки pause→tx и
future-attribute suppression, включая получение нового payload ID после паузы.

## Завершение proposal: безопасная точка и отрицательный эксперимент

`src/consensus.ts:53` опрашивает head, затем agreement; `src/http.ts:31` спит 10 ms после первого
промаха. При бюджете 7,324 ms/slot нельзя оставлять регулярный промах на каждом слоте. Однако это не
вновь обнаруженный доказанный большой резерв.

**Отрицательный результат:**
[обычный honest-v3](../reports/warp-tdd/native/critical-path-gloas-honest-v3.json) 4410,685 ms/32;
[Engine head experiment](../reports/warp-tdd/native/critical-path-gloas-honest-v3-engine-head.json)
4371,715 ms/32, всего −0,88%. Phase 0: 102,402→96,672 ms/slot. Consistency calls: 107→32.
Сохранённый [red log](../reports/warp-tdd/native/engine-head-controller-red.log) прямо фиксирует
порядок `bn → vc → engine head → head read → agreement`;
[green log](../reports/warp-tdd/native/engine-head-green.log) подтверждает проверку этого порядка.
Следовательно, прежний event уже стоял **до первого head read**. Неверно объяснять новый BN hook
устранением другого polling-окна, якобы оставленного экспериментом. Из этих двух прогонов нельзя
отделить небольшой эффект от вариативности соседних фаз.

Исходник `.cache/warp-native/engine-head-experiment.ts:178,224–246` ждёт VALID newPayload и VALID
forkchoiceUpdated для того же execution hash. Он остаётся экспериментом. Новый BN mark имеет
практический смысл для direct Engine transport, когда host перестаёт наблюдать эти запросы, и для
точной связи completion с canonical CL root. Его временная точка близка к старому Engine event; сам
по себе он не обещает дополнительного большого ускорения.

Первичные anchors Gloas (`.cache/warp-native/gloas/`):

| Место                                                                          | Что уже завершилось / чего ещё нет                                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beacon_node/beacon_chain/src/payload_envelope_verification/import.rs:229–332` | Envelope прошёл проверки, fork choice обновлён, envelope/columns записаны в DB. Canonical head и EL forkchoice ещё могут отставать.                           |
| `beacon_node/http_api/src/beacon/execution_payload_envelopes.rs:400–403`       | После полного envelope import вызывается `recompute_head_at_current_slot()`. Его `()` не является свидетельством успешного EL VALID.                          |
| `beacon_node/beacon_chain/src/canonical_head.rs:1034–1084`                     | Full-head snapshot загружает envelope из store и коммитится в cached head.                                                                                    |
| `canonical_head.rs:1133–1185,1210,1787–1839`                                   | HeadV2 event идёт перед асинхронным EL update. `execution_payload` event тоже означает import, а не успешный канонический FCU.                                |
| `beacon_node/beacon_chain/src/beacon_chain.rs:7027–7050`                       | Ветка `PayloadStatus::Valid`, затем `on_valid_execution_payload(head_hash)`; подходящий controlled completion anchor после успешного результата этого вызова. |

Минимальный hook ставится в последней точке, только при успешном `fork_choice_update_result`, а не
просто перед `Ok(())`: upstream также возвращает `Ok(())` для SYNCING/ACCEPTED и логирует некоторые
ошибки. Дополнительные условия: current slot совпадает с slot head; canonical root совпадает с FCU
`head_block_root`; Gloas cached head — `Full`, его envelope root и execution hash совпадают с
подтверждёнными root/hash. Это исключает ранний VALID FCU для EMPTY head, где EL подтвердил лишь
execution parent. Pectra использует аналогичный anchor
`.cache/upstream/lighthouse/beacon_node/beacon_chain/src/beacon_chain.rs:6275–6299`, но проверяет
payload самого canonical block: отдельного envelope/Full virtual node там нет.

Использовать bounded root mark через существующий `controlled::mark_root`; root связывается с точным
slot. До получения root controller может ждать отдельный slot-completion watermark, а затем
проверять root mark из того же snapshot и читать head. Лучше записать обе части под одним marks
mutex; не создавать неограниченную таблицу из всех 8192 roots. Ожидание — existing native wait с
реальным deadline, без polling fallback. После notification остаются однократные настоящие чтения CL
block / Gloas envelope / EL head и проверки slot, root, hash, timestamp, execution optimism.
Notification не заменяет их. Несоответствие после completion должно fault, а не молча перейти на
следующий слот.

Нельзя ставить success mark сразу после newPayload VALID, после envelope Imported, в HeadV2, после
HTTP 200 или безусловно после `recompute_head_at_current_slot()`: ни одна из этих точек сама по себе
не доказывает требуемую комбинацию canonical CL head + imported envelope + EL VALID head. FCU hook
также не должен удерживать дополнительные fork-choice locks через async ожидания.

## Численный бюджет и сохранённые измерения

Это диагностические величины, не слагаемые одной длительности. Вложенные таймеры, параллельные VC
jobs, Engine RTT и Geth execution нельзя складывать. CPU snapshots сняты последовательно EL/BN/VC до
и после advance, поэтому включают дополнительное wall time и возможный background/lookahead.
Нормализация на 32 продвинутых слота не превращает их в точную стоимость каждого слота.

Источники:
[metrics-gloas-direct-sync.json](../reports/warp-tdd/native/metrics-gloas-direct-sync.json),
[BN before](../reports/warp-tdd/native/metrics-direct-sync-bn-before.txt),
[BN after](../reports/warp-tdd/native/metrics-direct-sync-bn-after.txt),
[VC before](../reports/warp-tdd/native/metrics-direct-sync-vc-before.txt),
[VC after](../reports/warp-tdd/native/metrics-direct-sync-vc-after.txt).

| Величина                                    |                            Сохранённое значение | Значение для остаточного бюджета                                                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Весь advance, 32 slots                      |                     2956,230 ms; 92,382 ms/slot | Целевой общий последовательный путь ≤7,324 ms/slot, ещё минус first tx.                                                                                                                           |
| EL CPU delta                                | **338,356 CPU-ms**, 10,574 CPU-ms/advanced slot | Это CPU, не RTT. При условном сохранении всей работы и идеальном использовании лимита 2 CPU — 5,287 ms/slot, 43,310 s/8192 только для EL. Не физический floor из-за расширенного snapshot window. |
| BN CPU delta                                |                    2792,122 CPU-ms; 87,254/slot | Даже при условных 2 CPU получилось бы 43,627 ms/slot; требуется существенное сокращение CPU work, не только transport.                                                                            |
| VC CPU delta                                |                    1098,155 CPU-ms; 34,317/slot | Условно 17,159 ms/slot при 2 CPU; signing и background требуют отдельного измерения.                                                                                                              |
| FCU requests                                |           130 calls / 231,953 ms; 1,784 ms/call | Около 4 calls/slot, включая подготовку. RTT включает EL и ожидания; это не чистая сеть.                                                                                                           |
| getPayload / newPayload                     |                   32 × 1,647 ms / 32 × 3,185 ms | Частично находятся внутри production/envelope timers. Прямой transport не удаляет реальное исполнение.                                                                                            |
| BN production / block processing / envelope |                   7,269 / 7,679 / 3,489 ms/slot | Общие таймеры с вложенными crypto/state/EL/queue; не складывать с нижними строками.                                                                                                               |
| Production state process / state root       |                           0,996 / 0,599 ms/slot | Наблюдаемые последовательные участки внутри production. Остаточный kernel после crypto ещё не измерен.                                                                                            |
| Import core / state root                    |                           0,111 / 0,620 ms/slot | Небольшой измеренный участок, не основание для крупной переделки import.                                                                                                                          |
| Block DB write / envelope DB write          |                           0,230 / 0,042 ms/slot | Уже входят в общие processing timers; пропуск persistence не нужен и не разрешён.                                                                                                                 |
| CFS throttling                              |                delta 0 во всех трёх контейнерах | Текущий результат не объясняется CFS throttling. Ускоренная композиция может изменить загрузку.                                                                                                   |

Для Geth сохранённый
[хвост большого direct-sync прогона](../reports/warp-tdd/native/direct-sync-long-warp-el-tail.log)
содержит по 60 сообщений на блоках 8262–8321: `Updated payload` elapsed в среднем 0,482 ms,
`Imported new potential chain segment` 1,039 ms, `Chain head was updated` 0,045 ms. Это отдельное
окно большого прогона, не те же 32 slots. В сохранённом
[коротком EL log](../reports/warp-tdd/native/metrics-direct-sync-el.log) для блоков 65–96
соответствующие средние 0,347 / 0,637 / 0,034 ms (по 32 сообщения; исходник скопирован из
`.panda/metrics-24e7dc22/el.log`). Эти elapsed — отдельные внутренние spans Geth, не полный CPU
accounting и не замена Engine RTT. Разность RTT и такого span нельзя целиком объявлять сетевой
задержкой.

| Ранний численный gate | Максимум без резерва на tx | Практическая формула                                            |
| --------------------- | -------------------------: | --------------------------------------------------------------- |
| Один слот             |                7,324219 ms | `(60000 - T_first_tx_ms) / 8192`                                |
| 32 slots              |                 234,375 ms | `T_32 × 256 + T_first_tx ≤ 60000 ms`                            |
| 256 slots             |                    1875 ms | `T_256 × 32 + T_first_tx ≤ 60000 ms`                            |
| 8192 slots            |                   60000 ms | Измерять полный warp + первую успешную tx, без deferred работы. |

Условные 5,287 ms EL из CPU-строки оставили бы всего 2,037 ms до жёсткого slot budget для остальных
неперекрываемых участков. Это предупреждение для проектирования, не доказанный нижний предел:
неизвестна доля background и параллелизм EL. Аналогично нельзя вычитать все nested BN timers из 92
ms и объявлять остаток устранимым overhead.

## TDD и следующий короткий probe

До implementation определить failing checks: единственный owner времени при concurrent
advance/automine; raw RPC parity; graceful shutdown с pending queue; worker loss/ambiguous advance
без retry; VC recreation; отсутствие доступа к keys/Docker socket; exact-label cleanup с чужой
сетью.

Для completion hook отдельные негативные случаи: envelope ещё не импортирован; отсутствующие
columns; optimistic/SYNCING/ACCEPTED; VALID для Gloas execution parent на EMPTY head; invalid
payload; ошибка DB/import; неправильный slot/root/hash; смена canonical root после mark; timeout и
shutdown. Только совпадающий imported canonical head с действительным FCU VALID даёт notification.
Oracle replay и обычные проверки EL/CL не отключаются.

Первый probe после разрешённой реализации — 32 slots, затем 256 slots с epoch transition и первой
tx. Не запускать 8192, если формула таблицы не проходит. Записать в одном процессе worker monotonic
spans для advance BN/VC, head completion, root/head reads, consistency и всех phase waits. Отдельно
считать first-probe misses, количество polling attempts и фактическое время sleep: предыдущий
profile_phases wrapper на host не измерит relocated Consensus автоматически.

Нужны коррелированные по slot/root/hash BN timings: production/signature checks/state transition /
hashing/import/FCU; Geth build/import/head elapsed; реальные CPU snapshot boundaries по каждому
контейнеру. Выполнить последовательные A/B transport и crypto варианты при одинаковом bake/input,
без конкурирующей devnet нагрузки. Сохранять per-slot распределение и epoch spikes. Не складывать
перекрывающиеся spans и async signing-time sums; построить фактическую цепь зависимостей.

Пока не измерены: Docker-local HTTP RTT; остаточный crypto kernel и его subgroup costs; доля
background EL/BN/VC CPU; чистое время ожидания scheduler; число phase-0 polling misses после crypto;
стоимость новых boundary checks; длинный memory/disk/history рост. Все обязательные economics,
полный duty coverage, финальность, signing history, failure safety и post-warp operations затем
проверяются независимо для каждого выпускаемого bake. Короткий speed gate их не заменяет.
