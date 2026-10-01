# Честный warp: временный групповой signer для sync committee

2026-09-30. Изолированный crypto probe прошёл RED → GREEN; клиент ещё не реализует этот путь.
Результаты прочитаны из сохранённых отчётов; подготовка документа не меняет production-код.
Сопутствующие исследования: [worker/transport](warp-worker-research.md),
[общий минутный бюджет](warp-one-minute-research.md), [TDD acceptance](warp-tdd-acceptance.md).

## Основание и измерительный бюджет

Same-message randomized MSM прошёл 14 изолированных correctness tests, но его компонентный gate ≤2
ms остался RED: mean 3,329 ms cold / 4,229 ms warm, включая обязательную проверку subgroup каждой
индивидуальной подписи. Источники:
[candidate.json](../reports/warp-tdd/same-message/candidate.json),
[correctness](../reports/warp-tdd/same-message/candidate-correctness.txt). Выигрыш 3,6–4,7× на
verifier не доказывает такой же выигрыш whole warp.

Из [signing baseline](../reports/warp-tdd/shared-hash/baseline.json): 64 обычные подписи разных
roots за mean 20,234 ms с одним persistent worker, 14,081 ms с двумя; p95 20,515 / 27,891 ms. Serial
mean 19,929 ms. Это standalone surrogate executor, не прямое измерение Lighthouse Rayon pool.
Генерация ключей исключена, signing/serialization/job scheduling включены. Shared hash-to-curve
candidate затем прошёл 7 тестов: 64 подписи за 5,508 мс в том же режиме двух workers. Его gate ≤1 мс
остался RED. Дальнейший поиск по запросу пользователя ограничен алгоритмами: число потоков больше не
является предметом исследования.

Заранее установленный предварительный gate всего sync crypto — **mean ≤3 ms на слот**.
Диагностическое распределение этого бюджета: 1 ms signing + 2 ms verification. Один signing
component означает lookup всех живых ключей, построение четырёх сумм, четыре подписи, serialization
и scheduling; verification component — проверку четырёх contribution. Оба участка показывать
отдельно; p95 и first batch также сохранять. Подбюджеты не заменяют общий gate и не объявляются
отдельными пройденными release checks. Cold aggregate-PK construction измеряется и показывается
отдельно; его нельзя скрыть в fixture setup или исключить из end-to-end итога. Неперекрывающуюся
стоимость cold membership/PK preparation нужно прибавить к полному slot path. Компонентный PASS не
означает, что 8192 slots + первая tx уже укладываются в 60 s.

Сохранённые результаты [group-sync evidence](../reports/warp-tdd/group-sync/README.md):

| Форма результата  | Baseline mean | Candidate mean / p95 | Cold preparation | Mean ≤3 ms  |
| ----------------- | ------------: | -------------------: | ---------------: | ----------- |
| 4 × 128 positions |     26,020 ms |     2,331 / 2,458 ms |         0,307 ms | RED → GREEN |
| 1 × 512 positions |     27,816 ms |     1,563 / 1,612 ms |         0,266 ms | RED → GREEN |

Four-group candidate: 12 tests PASS. Full-shape candidate: 12 library + 2 CLI tests PASS. Проверены
byte equality, multiplicities, live-key replacement/missing, zero cases, subgroup и zeroization. Это
standalone blst 0.3.17, 8 timed batches с разными roots в неизменной Linux ARM64 test environment.
Оно не проверяет Lighthouse API/pool, реальную keymanager lifecycle, production guard, restart/skip,
Pectra native compatibility или whole warp. Cold preparation раскрыта отдельно; выигрыш компонента
не переносится автоматически на сеть.

## Исходный вариант: четыре contribution

| Представление                                | Совместимость с существующим клиентом                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Четыре настоящих `SyncCommitteeContribution` | Штатный `op_pool.insert_sync_contribution` уже принимает этот тип; production собирает `SyncAggregate` обычным способом.                                              |
| Один настоящий полный `SyncAggregate`        | Меньше crypto операций, но pool хранит contribution. Из одной полной подписи нельзя восстановить четыре subnet signatures; нужен дополнительный pool/production путь. |

Первым исследован кандидат с четырьмя contribution; ниже отдельно оценён полный aggregate, и выбор
между ними ещё не сделан. У Gloas `beacon_node/operation_pool/src/lib.rs:119` принимает contribution
без `VerifiedSyncContribution` wrapper и предполагает, что caller уже проверил подпись.
`get_sync_aggregate` (`:165`) выбирает pool по `(state.slot − 1, block_root)` и вызывает
`SyncAggregate::from_contributions`. У Pectra та же точка insert находится около `:110`. Сам pool,
его pruning и production не меняются.

Нельзя создавать фиктивный `VerifiedSyncContribution`: обычный verifier проверяет ещё selection
proof и подпись aggregator wrapper. Controlled endpoint принимает локальные contribution для block
inclusion, не выдавая их за проверенные gossip `SignedContributionAndProof`.

## Алгоритм и математическая эквивалентность

Для одного slot все sync committee positions подписывают один полный signing root `m`. Пусть
`c[j,i]` — число позиций ключа `i` в subnet `j`. Внутри одного вызова VC вычисляет:

```text
s[j] = Σ_i c[j,i] · sk[i] mod r
signature[j] = s[j] · H(m)
             = Σ_i c[j,i] · Sign(sk[i], m)
```

Это та же BLS aggregate signature, включая байтовое совпадение canonical serialization, что и
агрегация обычных индивидуальных подписей с теми же кратностями. Это не разрешает публиковать
произвольные individual signatures или признавать неверные исходные сообщения действительными. В
новом пути исходными данными являются реальные доступные VC keys и точные protocol duties.

VC получает прежний `SyncDuty`: `pubkey`, `validator_index`, `validator_sync_committee_indices`.
Последние описывают позиции, а не уникальные ключи. Сначала проверить диапазоны и точное однократное
покрытие 512 позиций; repeated pubkeys допустимы, repeated positions в описании — ошибка. Нельзя
заменить 512 позиций списком 64 уникальных validators без учёта кратностей.

Один blocking job берёт read lock текущего `InitializedValidators`, разрешает каждую участвующую
pubkey через `signing_method()`, проверяет локальность ключа и выполняет ephemeral sums/signing до
освобождения lock. `initialized_validators/src/lib.rs:570` возвращает signer только для известных
enabled validators. Lock не переносится через async await; он берётся внутри blocking closure. Из
неё выходят только четыре contribution, не scalar/secret-key material.

Так задаётся точка линейности с keymanager DELETE/disable: завершившееся до lookup отключение уже не
позволяет подписать новый batch; отключение во время короткого read lock ждёт окончания batch. После
успешного удаления следующий batch заново делает lookup. Нельзя сохранять группу ключей, scalar sums
или Arc signing methods между слотами. Обычный cached public committee не является разрешением
использовать отключённый private key.

## Secret arithmetic и нулевые случаи

Secret arithmetic должна жить в маленьком закрытом BLS helper. Предпочтительны field operations blst
над Fr, а не переменной длины BigInt. Borrow исходных secret keys; временные scalar/Fr/byte buffers
имеют Drop zeroize, без Debug/serialization/logging и без неявного Clone секретного accumulator.
Возвращать только публичную подпись. Secret serialization, если она нужна адаптеру, должна
оставаться в zeroizing buffer до преобразования; обычный `[u8;32]` без очистки не подходит.

Промежуточная сумма может равняться нулю, а финальная — быть ненулевой. Поэтому проверять каждый шаг
как создание допустимого SecretKey неправильно: `crypto/bls/src/generic_secret_key.rs:80` отвергает
zero. Accumulator должен допускать zero как обычный элемент Fr. Финальный nonzero преобразуется в
краткоживущий SecretKey и подписывает штатный root.

Финальный zero хотя бы одной subnet переводит **весь batch** в прежний individual-message /
direct-sync путь. Нельзя послать infinity contribution в новый endpoint: отдельный contribution
verifier её отвергнет. Это не доказывает невалидность итогового полного SyncAggregate. Например,
subnet 0 из пар `sk=1` и `sk=r−1` даёт infinity, но остальные subnet с `sk=2` дают ненулевую полную
подпись. Старый direct-sync собирает contributions из проверенных individual messages и может
построить штатно валидный full aggregate без отдельной contribution verification.

Если уже полная nonempty committee имеет zero aggregate PK/signature, работает обычное upstream
отклонение. Это не empty aggregate exception: `generic_aggregate_signature.rs:191–214` разрешает
специальный infinity случай лишь для пустого набора в `eth_fast_aggregate_verify`. Сам controlled
full-coverage режим пустого набора не допускает. Не вводить signature bypass ради zero fixture.

Подтверждённые primary APIs доступны уже в Pectra blst 0.3.14:
[exports.c](https://github.com/supranational/blst/blob/v0.3.14/src/exports.c#L22) содержит
`blst_fr_add` (:22), `blst_fr_from_scalar` (:67), `blst_scalar_from_fr` (:83), `blst_sk_check`
(:104). Fr addition допускает zero; `blst_sk_add_n_check` (:107) нельзя использовать как основание
прерывать суммирование при нулевом префиксе. Обязательный пример: `1 + (r−1) + 2`.
[Rust bindings](https://github.com/supranational/blst/blob/v0.3.14/bindings/rust/src/lib.rs) дают
`From<&SecretKey> for &blst_scalar` и проверенный `TryFrom<&blst_scalar> for &SecretKey`; последний
отвергает zero. Исходный `GenericSecretKey::point()` Lighthouse даёт borrow underlying key. Это
позволяет обойти serialization исходных SK и sign через borrow финального scalar.

Хотя owned blst SecretKey имеет `#[zeroize(drop)]`, borrowed view финального scalar сам ничего не
очищает. Наш Drop guard обязан очистить созданные `fr.l` и `scalar.b`, включая scratch, на success и
error. Не возвращать такой borrow наружу и не создавать незащищённые by-value копии. Наличие этих
API подтверждено по исходникам; standalone group implementation с blst 0.3.17 уже compiled/tested в
probe выше. Интеграция в Gloas и native совместимость с Pectra blst 0.3.14 остаются release gates.

## BN admission: независимая проверка участников

Новый route только в controlled режиме; пример имени `/lighthouse/panda/sync_contributions`.
Использовать существующий BeaconNodeHttpClient и типы contribution, без передачи keys или
предложенного VC aggregate public key. JSON размер и количество ограничить четырьмя элементами.

BN выводит root, committee, fork и genesis root из **одного pinned head snapshot**. Для committee
используется `snapshot.beacon_state.get_built_sync_committee((slot + 1).epoch(...), spec)`.
`BeaconChain::sync_committee_at_next_slot(slot)` (`beacon_chain.rs:1408` у Gloas) подтверждает
правило выбора эпохи, но сам заново читает canonical head: два отдельных root-check вокруг него не
связывают committee с root при переходе A→B→A. Поэтому admission не должен смешивать эти чтения.
Membership относится к **slot + 1**, а sync signing epoch — к **slot**. Fork/domain/genesis root
берутся штатным путём из того же snapshot. Для каждой subnet BN заново получает все 128 public-key
positions с кратностями и вызывает
`sync_committee_contribution_signature_set_from_pubkeys(...).verify()`
(`consensus/state_processing/src/per_block_processing/signature_sets.rs:738`). Это обычная проверка
реальной aggregate signature, включая subgroup checks подписи; public keys берутся из собственного
валидированного pubkey cache.

До изменения pool проверить все четыре элемента: одинаковые slot/root, текущий controlled slot,
canonical root, subnet indices ровно 0–3 без дублей, все bits установлены, все signatures корректны.
После verification повторно убедиться в текущих root и controlled slot. Затем вставить четыре
contribution существующим методом и поставить прежний `sync_contributions_<root>` mark. Ошибка
любого элемента не даёт full-completion. Повтор одинакового корректного batch может быть
идемпотентным: existing pool не заменяет contribution на вариант с тем же числом bits.

Admission в candidate pool не является доказательством EL VALID. Существующий независимый controller
barrier проверяет Gloas envelope/EL agreement и точный root до завершения фазы; его нельзя удалять.
Root mark удостоверяет sync coverage, а не исполнение payload.

## Дополнительный резерв: aggregate public key уже находится в state

`SyncCommittee` хранит `aggregate_pubkey` рядом с полным списком
(`types/src/sync_committee/
sync_committee.rs:39`). Gloas
`types/src/state/beacon_state.rs:1770–1794` вычисляет его обычной агрегацией всех выбранных pubkeys
с повторениями. `get_built_sync_committee` (:1677; Pectra `types/src/beacon_state.rs:1154`) выбирает
current/next committee по запрошенной эпохе.

Сейчас `sync_aggregate_signature_set` снова собирает все 512 participant keys при полных bits (Gloas
`signature_sets.rs:814–850`, Pectra `:627–661`). Отдельный controlled-only fullbits branch может
декомпрессировать `committee.aggregate_pubkey` и сформировать `SignatureSet::single_pubkey` с
прежними signature, message и domain. Partial bits и empty/infinity special case сохраняют обычный
путь. Здесь не требуется общий mutable public-key cache.

Нужна именно `PublicKeyBytes::decompress()` с нормальной валидацией: callback `decompressor` обычно
ищет ключ validator registry, куда whole-committee aggregate PK не входит. Также
`get_built_sync_committee` сам не проверяет соответствие stored aggregate списку pubkeys.
Эквивалентность опирается на invariant настоящего локально вычисленного consensus state; нельзя
переносить этот shortcut на произвольный недоверенный supplied state без отдельного
обоснования/проверки. Oracle должен сравнить оба пути на реальных state до/после period transition,
повторных ключах и corrupted signatures, включая fallback при непригодном aggregate PK.

Этот резерв относится к проверке полного агрегата в блоке. Он **не заменяет** четыре subnet PK при
admission четырёх contribution: проверка только их суммы может скрыть взаимно компенсирующие ошибки
отдельных contribution. Измеренных timing-результатов этого shortcut пока нет; не прибавлять
предполагаемый выигрыш к бюджету заранее.

## Исследовательская альтернатива: один полный SyncAggregate

Crypto-компонент этого варианта измерен выше; клиентская интеграция не реализована. Первоначальная
оценка, что полный aggregate обязательно требует большой перестройки pool, была слишком сильной.
`OperationPool::get_sync_aggregate` (Gloas `beacon_node/operation_pool/src/lib.rs:165`, Pectra
`:156`) уже выводит точный ключ `(state.slot() - 1, state.get_block_root(state.slot() - 1))`. Перед
прежней сборкой contributions можно добавить lookup одного bounded
`Option<(slot, root, verified_full_aggregate)>`. Совпадение exact key возвращает clone готового
aggregate; несовпадение оставляет прежний путь. Разрезать подпись на четыре части не нужно. Оба
production call site остаются прежними: Gloas `block_production/gloas.rs:630` и pre-Gloas
`beacon_chain.rs:6029`.

VC заново проверяет live local keys и точное покрытие всех committee positions, вычисляет один
ephemeral weighted scalar и одну настоящую подпись. Прежние правила borrow/zeroize, missing key,
remote-key fallback, exit и domain сохраняются. Нулевой промежуточный scalar допустим; нулевая сумма
отдельной subnet больше не требует fallback, поскольку отдельной subnet signature нет. Если сумма
всего committee равна нулю, сохранить обычный upstream результат через прежний путь, без принятия
infinity для непустой committee. Новый endpoint принимает только slot, block root и полный
aggregate; aggregate public key от VC не принимается.

BN берёт один snapshot, проверяет current slot/root и все 512 bits, выбирает committee для slot + 1,
декомпрессирует его `aggregate_pubkey` с валидацией и выполняет настоящую BLS-проверку с sync domain
для slot. Это отдельная admission boundary для полного результата. Она не пытается доказать
корректность четырёх individual contributions, которых здесь нет. Доверие к stored aggregate PK
ограничено invariant собственного валидного consensus state, описанным выше. После проверки current
root/slot BN сохраняет результат и лишь затем ставит root-bound coverage mark. Обычный block import,
проверка state root, transition и независимое EL agreement сохраняются.

Дополнительный storage contract требует явных правил:

- Insertion и lookup работают только в явно выбранном controlled full-sync режиме; ordinary mode и
  восстановленный ordinary pool не используют поле. Ordinary partial aggregates сохраняют прежний
  путь; honest full-sync production требует полного результата по правилу ниже.
- Root и slot проверяются перед replacement. Поздний запрос за старый slot не может вытеснить
  текущую запись; одинаковый валидный запрос идемпотентен. Corrupt request не меняет запись и mark.
- Lookup использует block root из **переданного production state**, а не последнее значение
  clock/head. Это защищает reorg production от подстановки aggregate с другой ветки.
- `prune_sync_contributions` (:193; Pectra :184) очищает также запись старше предыдущего slot.
  Bounded Option ограничивает память и без prune, но не отменяет проверку stale id.
- Прежние `sync_contributions` действительно сохраняются в `PersistedOperationPoolV20`
  (`persistence.rs:38,70,112`). Поэтому отсутствие persistence у новой записи — явное отличие, а не
  полная эквивалентность существующему pool. Поле может быть ephemeral без изменения schema только в
  ограниченном fault/reset контракте. Тогда `persistence.rs:207` и `Default` инициализируют `None`;
  reset создаёт пустой pool. Потеря этого единственного batch при BN restart до следующего proposal
  должна приводить к fault/reset или доказанному повторному admission. Нельзя незаметно продолжить с
  пустым aggregate и штрафами. Если требуется прозрачный restart, persistence/replay становится
  отдельным изменением.
- `PartialEq` pool (:887) и observability должны явно учитывать выбранную transient семантику.
  `num_sync_contributions()` не следует подделывать под четыре полученные contribution; coverage
  подтверждается реальным блоком/state и отдельным корректным mark.

Текущий documented crash contract уже требует down/up: [usage](usage.md), раздел ограничений, и
[plan](plan.md), пункт resume. W16 в [acceptance](warp-tdd-acceptance.md) явно допускает fault/reset
без автоматического resume. Clock также неперсистентен: `controlled_clock.rs:11–20,59` хранит time и
marks в памяти, а `network.ts:96–101` задаёт первоначальное время genesis + 11,5 s в launch env. Это
обосновывает ограниченный scope, но ещё не гарантирует обнаружение произвольного BN restart живым
controller: `Consensus.connect` сверяет clocks только при соединении, последующий advance может
снова передать более позднее время. Native/live failure gate обязан доказать bounded error до
следующего proposal либо потребует отдельного минимального restart guard. До этого ephemeral вариант
не готов к выпуску. Сохранение полной подписи как фиктивных subnet contribution недопустимо.

### Более локальная защита: production требует полный aggregate

Предпочтительное следующее исследование — предусловие production, а не сквозной nonce-протокол для
всех Clock API. В явно выбранном controlled full-sync режиме заменить fallback на пустой aggregate
ошибкой, когда требуемого полного результата нет. Точки перед `unwrap_or_else(SyncAggregate::new)`
находятся в Gloas `block_production/gloas.rs:628`, pre-Gloas пути этого же клиента
`beacon_chain.rs:6027` и Pectra `beacon_chain.rs:5410`. Обе версии уже имеют
`BlockProductionError::MissingSyncAggregate` (`errors.rs:328` и `:293`). Проверять как `None`, так и
неполные bits; одного наличия объекта недостаточно.

Parent slot берётся из `state.latest_block_header().slot` того же production state после
`complete_state_advance`, а parent root — из контекста этого же production snapshot. Не перечитывать
live head для решения о разрешённом исключении. Pool lookup уже связывает aggregate с
`state.slot() - 1` и соответствующим block root. Admission остаётся настоящей BLS-проверкой; битовое
предусловие не делает непроверенную подпись проверенной. Обычный import verifier и EL проверки
сохраняются.

Bootstrap допускается только при одновременных `proposed_slot == spec.genesis_slot + 1` и
`parent_root == chain.genesis_block_root`. Это исключение для отсутствующих genesis-slot duties, а
не «первый запрос после запуска». В обычном последовательном proposal отсутствие полного aggregate
возвращает production error до получения VC unsigned block и вызова `validator_store.sign_block`
(`validator_services/block_service.rs:546`). Уже полученный до перезапуска блок с настоящим полным
aggregate остаётся валидным независимо от жизни pool.

**Gap в honest full-sync режиме тоже fail closed.** Условие `parent_slot < proposed_slot - 1` не
доказывает явный skip: оно возможно после сбоя, восстановления старого head или запроса будущего
слота. Исключение для `skipSlots` требует явного разрешения на конкретные proposal slot и parent
root; потеря разрешения после restart должна закрывать production, а не расширять исключение.
Ordinary mode сохраняет прежние правила empty/partial aggregate и gap.

Существующий Gloas `prepare_controlled_skip` не является таким разрешением:
`bakes/gloas/native/prepare_skip.rs:9–16` автоматически замечает отставание head более чем на 32
слота и кэширует переходы до `current_slot + 1`. Он не получает исходную команду пользователя или
разрешённую пару slot/root. `skip_ready` ставится timer после каждого успешного per-slot task
(`bakes/gloas/patch.py:97–102`), в том числе когда preparation ничего не делал. Сам runtime
`Network.skipValidator` (:330–374) знает явную операцию и целевое время, но отправляет только
обычный BN `/advance` и читает этот mark. Малые skip ≤32 вообще не попадают в preparation.
Следовательно, ни большой gap, ни `skip_ready`, ни наличие cached advanced state нельзя использовать
как permit. Будущий target-bound сигнал мог бы исходить из этого явного runtime вызова, но пока его
нет.

До отдельного TDD для explicit skip default не меняется и full-sync вариант не выпускается. Нужны
проверки: lost Option после admission/mark, missing/partial/stale root, строгий bootstrap,
неожиданный gap, explicit skip 1/32/33 slots и первый следующий consecutive proposal, restart до и
после получения unsigned block, ordinary mode. Более поздний переход Base→Altair также требует
явного анализа первого sync-enabled блока; текущие Pectra/Gloas стартуют с sync duties в genesis.
Ориентир самого production guard — десятки строк в двух production местах, отдельно от mode wiring,
target-bound skip signal и тестов. Экономию или готовую restart safety пока не заявлять.

По числу криптографических операций это 1 sign + 1 admission verify вместо 4 + 4, без subnet PK
cache и без сборки 512 signature positions. По diff добавляются `operation_pool/lib.rs` и
инициализация `persistence.rs`, зато упрощаются contribution validation и subnet bookkeeping.
Предварительно это тот же порядок **300–500 production lines, около 9–11 Rust files** с учётом
private BLS helper/export, VC trait/store/service, HTTP client/route/admission и pool; это
непроверенная оценка, отдельно от тестов и profile glue. Она может оказаться меньше
four-contribution варианта с public-key cache, но это подтвердит только конкретный diff. Новый
небольшой storage branch не равен новой consensus state machine, однако его restart/reorg контракт
обязателен.

Минимальный TDD добавляет к общим gates: byte equality полного aggregate с ordinary 512-position
aggregation; zero subnet + nonzero full aggregate; final full zero; stale root/slot, ABA snapshot,
period boundary, corrupt state aggregate PK, partial bits, idempotent duplicate и out-of-order
replacement; prune/reset/BN restart после admission; ordinary mode; блок, принятый неизменённым
clean-upstream verifier. Скорость whole crypto path измеряется отдельно от correctness и от
8192-slot warp. Standalone mean ≤3 ms уже подтверждён; integrated slot path и ≤60 s не доказаны.

## Исследовательский резерв: reuse точного результата BLS

Текущий `crypto/bls/src/impls/blst.rs:257` использует positive cache только для single-key
`fast_aggregate_verify`. Batch `verify_signature_sets` (:36–119), который вызывает block import
через `block_signature_verifier.rs:460`, этот cache не читает. Поэтому даже admission полного
aggregate с тем же root/domain/signature не исключает повторную BLS-проверку внутри блока.

Отдельный controlled-only кандидат: после обычного построения aggregate public key проверять
canonical tuple `(domain-bound signing root, aggregate PK bytes, signature bytes)` в bounded success
cache. Только misses идут в прежний randomized batch verifier; новые successes добавляются лишь
после успешной полной проверки. Не кэшировать false, не давать внешнего insertion API, не заменять
membership/bitfield/state checks наличием записи. Пустой исходный batch сохраняет прежнее поведение;
непустой batch из одних доказанных hits может завершиться успешно. Это reuse уже установленного
криптографического факта, а не `NoVerification` для непроверенного входа.

Fullbits state-PK shortcut позволяет admission и import получать тот же tuple без повторного
суммирования 512 public keys. Для других наборов точный aggregate PK сначала всё равно надо получить
штатно. Нужны differential tests на смену root/domain/key/signature, partial miss, невалидный
элемент batch, eviction и ordinary mode. Сейчас ни hit rate в реальном warp, ни timing-выигрыш
такого расширения не измерены; его нельзя заранее засчитывать в бюджет.

Границы общего verifier: cache capacity 512 ограничивает память, но не размер допустимого
`SignatureSet` batch. Существующий `panda_verified_signature::verify_batch` отвергает >512 входов,
поэтому его нельзя напрямую использовать вместо upstream general verifier. Обязателен тест 513
валидных sets. Structural checks, наличие signature point, subgroup, непустой список ключей и
вычисление текущего aggregate PK идут до lookup. All-hits для непустого batch допустим; пустой
исходный batch сохраняет прежний отказ. Failed miss-batch не прогревает даже его valid-prefix.

При фиксированных Ethereum POP DST и пустом augmentation полный tuple достаточен для повторной
криптографической проверки. Разные membership lists с одинаковым aggregate PK не различаются этим
фактом, поэтому membership/bitfield/indices проверяются отдельно. Если DST/augmentation станут
параметрами, namespace cache должен включать их. Существующий cache принимает также success
randomized64-bit batch: reuse сохраняет эту вероятностную гарантию, а не доказывает независимую
повторную проверку. Самая консервативная первая версия может читать только positives от обычной
single verification; provenance и hit-rate такого ограничения ещё не реализованы.

## Отдельный резерв Gloas PTC: кратности публичных точек

PTC не повторяет sync committee workload. `compute_ptc_with_cache`
(`types/src/state/beacon_state.rs:3610–3637`) выбирает 512 positions из attestation committees
**данного slot**. При 64 validators и 32 slots это два distinct validator keys на слот, с
повторениями в PTC. VC берёт один `PayloadAttestationData` и подписывает его для обеих duties
(`validator_services/payload_attestation_service.rs:370–404`). Это подтверждает direct-sync
измерение: 64 BN gossip verifications за 32 advanced slots. После изменения registry число ключей
нужно выводить из настоящего PTC; константу «2» в алгоритм вшивать нельзя.

Сообщение включает root, slot, `payload_present` и `blob_data_available`
(`types/src/attestation/payload_attestation_data.rs`). В общем случае возможны четыре разных набора
flags; их нельзя агрегировать как одинаковый signing root. VC сейчас получает flags штатным API из
фактических envelope/availability observations (`beacon_chain.rs:2200–2260`). Нельзя подменять их
заранее ожидаемыми true/true.

Pinned signer использует `Domain::PTCAttester`, lookup live key и
`doppelganger_bypassed_signing_method` (`lighthouse_validator_store/src/lib.rs:1442–1469`). Этот
helper явно предназначен для non-slashable messages (:265), а PTC path не вызывает slashing DB. Это
характеристика данного pinned PTC пути, не разрешение обходить защиту blocks/attestations.
Сохранение обычных индивидуальных PTC signatures оставляет keymanager/remote/exit lifecycle без
нового secret API.

Вместо groupSK здесь сначала следует проверить меньшую замену:

```text
ordinary: Σ по всем занятым PTC positions signature[validator(position)]
candidate: Σ по distinct validators c[i] · signature[i]
```

То же равенство действует для public keys. Все `c[i]` выводятся из точных positions/aggregation
bits; отбрасывание повторных позиций изменило бы подпись и запрещено. Public integer double-and-add
для `c>0` требует `floor(log2(c))` doublings и `popcount(c)-1` additions, затем сложения результатов
разных ключей. Для двух ненулевых весов с суммой 512 это до 24 групповых операций вместо примерно
512, отдельно в G2 для signatures и G1 для keys. Это оценка количества операций, не измеренная
скорость: doubles/adds, cloning и подготовка имеют свою стоимость.

Точки: `operation_pool/src/lib.rs:243–266` сейчас добавляет signature один раз на каждую позицию;
`state_processing/.../signature_sets.rs:389–406` собирает повторяющиеся PTC public keys, затем
`bls/src/impls/blst.rs:94–103` снова агрегирует список. Узкая замена accumulation сохраняет обычные
сообщения, API, per-validator verification, наблюдение голосов, fork choice и состояние. Signature
helper может использовать существующие `AggregateSignature::add_assign_aggregate` и clone; для
public-key helper нужна небольшая безопасная обёртка над backend point addition. Для неодинаковых
messages или необычного представления действует прежний путь.

Новый direct aggregate API математически возможен, но сложнее и здесь не первый кандидат: `PtcDuty`
содержит только pubkey/index/slot (`common/eth2/src/types.rs:859`), а не кратности, так что VC ещё
нужен достоверный positional context. Кроме того, обычный verifier принимает только первый valid
vote для `(slot, validator)`
(`payload_attestation_verification/
gossip_verified_payload_attestation.rs:61–73,147–158`). Fork
choice затем **перезаписывает** flags (`proto_array_fork_choice.rs:727–737`). Приняв false/false,
нельзя позднее пропустить true/true aggregate тех же validators мимо observed guard. Группировка
обязана учитывать полный datum. Нельзя делать фиктивные individual messages/Verified wrappers из
aggregate.

Также indexed PTC допускает повторные validator indices. Передача weighted 512-entry aggregate в
существующий `on_payload_attestation` (:1450–1487) повторно разворачивает каждого validator во все
его positions; поэтому новый endpoint не гарантирует экономию даже после сокращения BLS.
Дедупликация только применения одинаковых vote effects может быть отдельной эквивалентной
оптимизацией, но нельзя менять веса cryptographic attestation или объявлять изменённый indexed
объект проверенным. Предпочтительный public-point accumulation путь вообще не меняет fork choice.

Данные из `metrics-direct-sync-{bn,vc}-{before,after}.txt`, то же окно 32 advanced slots:

| Таймер                                | Delta / 32 |
| ------------------------------------- | ---------: |
| VC PTC sign-and-publish, включая POST |   5,966 ms |
| Вложенный VC POST                     |   5,013 ms |
| Остаток sign-and-publish без POST     |   0,954 ms |
| BN gossip verification, 64 calls      |   4,378 ms |
| VC data GET                           |  10,872 ms |
| BN data production                    |  0,0049 ms |

Таймеры вложены/перекрываются; их нельзя суммировать в slot budget. Остаток 0,954 ms включает
подписи и прочую локальную работу, это не чистый BLS benchmark. Signature/PK accumulation отдельно
не измерена. PTC 2→1 signing сам по себе не выглядит главным резервом и не доказывает minute warp.

Следующий isolated TDD probe, пока не выполненный: baseline делает штатные 512-position signature и
PK additions; candidate считает точные кратности и делает public double-and-add. Подписи и
валидированные ключи одинаковы в обоих путях; неизменившийся signing вынести из обоих timers.
Показывать отдельно preparation/counting, G2 accumulation, G1 accumulation и whole construction с
одинаковой обязательной BLS verification. Независимый byte-equality oracle не начислять одному пути
дважды. Предлагаемый gate до запуска: при 2 и 8 distinct keys mean construction candidate не более
50% baseline, а mean construction + verify не выше baseline; также раскрывать p95 и cold batch. Это
критерий полезности микроалгоритма, не обещание latency сети. Для 512 distinct keys нужен прежний
путь без регрессии. Сохранить baseline до реализации candidate; реалистичный warm цикл — не менее 64
distinct signing roots с полными 512 positions в неизменной test environment.

Correctness: 1/2/8/64/512 distinct keys, weights 0/1/2/255/256/257/511/512, partial/full bits,
перестановки, несколько data flags/root/domain, cancellation/infinity, malformed input и corrupted
signature. Для каждого случая сравнить canonical bytes aggregate signature/PK, bits и прежний verify
result. Native differential: `duplicate_after_valid`, `packs_by_ptc_weight`,
`payload_attestation_sets_all_duplicate_ptc_positions`, `multiple_data_combos_capped`, side-chain
PTC, одинаковые fork-choice votes и итоговый block/state. Никакого нового допуска голосов или
изменения их последовательности. Абсолютный выигрыш и влияние на 60 s пока неизвестны.

## Lifecycle и совместимость

- **Missing/disabled key:** diagnostic failure; ни подстановка ключа, ни cached groupSK, ни неполный
  successful batch. Если duty polling уже исключил ключ, full-position coverage всё равно
  обнаруживает недостачу. Удаление файла на диске без обновления VC registry не эквивалентно
  keymanager DELETE; не заявлять более сильную гарантию, чем реализует upstream key lifecycle.
- **Remote signer:** narrow group path требует все keys local. При Web3Signer использовать весь
  прежний individual path. Не путать `not local / unsupported` с `missing / disabled`.
- **Exit:** не фильтровать действующий sync committee по active validator list. Вышедший validator
  может оставаться назначенным на текущий период. Committee/indices — источник истины.
- **Period/fork/reorg:** прежний duty polling сохраняется, следующая группа строится заново. BN
  независимо проверяет committee для slot + 1 и подписанный root. Неправильные stale duties не
  превращаются в успешный mark.
- **Slashing protection:** блоки, attestations, SQLite signing history и PTC не изменяются. Sync
  messages уже используют non-slashable signer path в `lighthouse_validator_store/src/lib.rs:768`;
  новый API не должен принимать произвольный domain.
- **Observability:** четыре aggregate signing jobs не должны логироваться как 64 выполненных
  индивидуальных jobs. Экономика/coverage проверяется по реальному state, не по счётчику jobs.

## Объём изменения: оценка до реализации

Оценка **300–500 production lines, около 8 Rust files / 7 логических модулей** пока не проверена
реальным diff. Отдельно потребуются patch/install glue, profile sourceFiles/nativeTests и тесты. Это
не «20 строк» и не готовая реализация. Ожидаемые участки:

1. Закрытый BLS ephemeral scalar helper и его экспорт.
2. Метод `ValidatorStore` с narrow sync-only аргументами.
3. `LighthouseValidatorStore`: live-key lookup, signing context, blocking job.
4. `validator_services/sync_committee_service.rs`: controlled branch, прежний fallback.
5. `common/eth2/src/lib.rs`: typed HTTP client method.
6. `beacon_node/http_api/src/lib.rs`: controlled-only routing.
7. BN admission handler рядом с `http_api/src/sync_committees.rs`, reuse existing signature-set
   helper и op_pool. Не менять consensus transitions, production или pool representation.

Pectra отправляет individual sync messages через другой VC service/trait shape; общий helper
переносим, но две точки установки проверяются независимо. Default/baseline client не использует
новый route и group signer.

## Выполненный probe и оставшиеся release gates

Standalone baseline и candidate обеих форм сохранены в
[reports/warp-tdd/group-sync](../reports/warp-tdd/group-sync/README.md), включая исходники и RED →
GREEN. Baseline использует 64 ordinary signatures, обычную randomized verification и position
aggregation; candidate — ephemeral sums и настоящую verification результата. Независимые повторные
oracle verifications исключены из обоих timers. В probe проверены 1/2/64/512 **positions**, не более
64 distinct keys. Наличие этих тестов не закрывает native/integration сценарии ниже.

Оставшаяся acceptance matrix:

- Native byte equality всех четырёх signatures и итогового SyncAggregate с обычной агрегацией;
  разные multiplicities, roots/domains и поддерживаемые размеры validator registry.
- Intermediate zero → nonzero, final zero, mod-r wrap, пустой набор, неправильный key/root/domain,
  неверные/repeated/out-of-range positions, один повреждённый subnet, infinity/non-subgroup
  signature.
- Zero одного subnet при ненулевом полном aggregate: fallback всего batch через прежний direct-sync
  даёт тот же блок/state, что ordinary signatures. Standalone oracle с обязательной verification
  каждой subnet моделирует более строгую границу и не заменяет этот native differential check.
- Live lookup при удалении/отключении между batch, concurrent disable, stale duties и remote signer;
  zeroize на success/error и запрет сохранения secrets в результирующих/cache структурах.
- Period boundary last slot, следующий slot, fork boundary, exit при оставшейся duty и deposit,
  который становится участником следующего committee. BN не принимает membership от VC на веру.
- Все четыре contribution валидируются до insertion; corruption/partial coverage/timeout не дают
  full mark. Baseline mode не открывает route. Existing pool и ordinary block import проверяют
  итоговый агрегат; независимый clean-upstream replay получает тот же consensus state.

Измерять отдельно live lookup/scalar adds/signatures, serialization/job wait, four-signature verify,
public-key aggregation cold/warm и whole crypto path; fixture key generation вынести, а нужную в
реальной работе cold preparation не скрывать. Ускорение не обосновывать только числом signing jobs.
После пройденного standalone component gate ≤3 ms нужен whole-path 32/256-slot gate с первой tx;
лишь затем полные два 8192-slot прогона. Неизвестны integrated signer/admission стоимость и влияние
на остаточный BN/EL serial path; **60 s не доказаны**.

Для каждого выпускаемого bake отдельно обязательны red→green evidence, profile fingerprint,
validator economics/rewards, полное duty coverage, настоящая финальность, EL/CL agreement, история
подписей, bounded missing-key failure и работа контрактов после warp. W18 разрешает aggregate signer
с проверенной эквивалентностью, но не отменяет остальные W-критерии.
