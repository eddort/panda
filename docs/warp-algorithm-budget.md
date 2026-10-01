# Алгоритмический бюджет честной перемотки

Срез 2026-09-30. Только чтение pinned source и сохранённых измерений; новых запусков и изменений
клиента нет. PTC рассматривается отдельно. Upstream source ниже закреплён на Gloas
`2d281dfa1b407f7c81cd123954a9fd18ee8f02d2`; ссылки на `.cache/warp-native/gloas` относятся к
локальному overlay исследуемого bake. Настройки исполнения не являются переменной этого
исследования.

**8192 слота за 60 с пока не обоснованы.** 7,324219 мс/слот — верхняя средняя граница без вычета
первой последующей транзакции и фиксированных расходов. Реальный допустимый бюджет ещё меньше.

## Практический ответ: сколько займёт 8192 слота

Встроенный клиент пока не изменён этим прототипом, поэтому измеренного ускорения сети от него нет.
Нынешние 2,956 с на 32 слота линейно дают **756,8 с, около 12 мин 37 с** на 8192. Это оценка по
короткому запуску; точное время advance в прежнем длинном тесте не сохранилось.

Если предположить, что сокращение isolated sync crypto **27,816 → 1,563 мс** целиком переносится на
последовательный путь каждого слота, получится `(92,382 − 27,816 + 1,563) ×8192 /1000` = **541,7 с,
около 9 мин 2 с**. Это условная модель: приблизительно **1,40×** для всей перемотки, или **28,4%
меньше времени**, при **17,8×** для одного компонента. Перекрытие стадий и новые расходы интеграции
неизвестны; модель не является измеренным прогнозом. Первая следующая транзакция сюда ещё не
включена и должна измеряться вместе с integrated warp.

Следовательно, даже эта условная оценка не приближается к требованию минуты. Компонентный результат
нельзя представлять как ускорение всей сети в 17,8 раза или как выполненную задачу ≤60 с.

## Что измерено

| Наблюдение                                                             |                                           Время | Что оно доказывает                                |
| ---------------------------------------------------------------------- | ----------------------------------------------: | ------------------------------------------------- |
| Full sync, ordinary 64 signatures + batch64 + 512-position aggregation |                               27,816214 мс mean | Исходный изолированный компонент                  |
| Full sync, ephemeral sum + 1 signature + general batch1                |               1,562515 мс mean; 1,611750 мс p95 | Реальный криптографический выигрыш; 14 tests PASS |
| В том числе sign + secret sums / required verification                 |                          0,415114 / 1,127026 мс | Последовательные стадии одного harness batch      |
| Cold public committee preparation                                      | 0,266209 мс, включая 0,233208 мс PK aggregation | Отдельная подготовка, вне steady total            |
| Direct-sync сеть, 32 слота                                             |               2956,230250 мс, 92,382195 мс/слот | Старый bake с 64 индивидуальными sync signatures  |

Источники: [full baseline](../reports/warp-tdd/group-sync/full-baseline.json),
[full candidate](../reports/warp-tdd/group-sync/full-candidate.json),
[environment/provenance](../reports/warp-tdd/group-sync/environment.json),
[direct-sync network](../reports/warp-tdd/native/metrics-gloas-direct-sync.json). Последний отчёт
привязан к bake `e41c863b…`; это **не** замер сети после интеграции group signer. Вычитание
26,253699 мс из 92,382195 мс дало бы 66,128496 мс, но даже эта арифметика не является прогнозом:
компонент и сеть измерены разными путями, их перекрытие неизвестно.

Разности [BN before](../reports/warp-tdd/native/metrics-direct-sync-bn-before.txt) /
[after](../reports/warp-tdd/native/metrics-direct-sync-bn-after.txt), делённые на 32:

| Стадия                                           |       мс/слот | Вложенность                                                      |
| ------------------------------------------------ | ------------: | ---------------------------------------------------------------- |
| Block production целиком                         |         7,269 | Включает получение payload и вложенные стадии                    |
| ↳ production process / state root                | 0,996 / 0,599 | Не прибавлять к строке production                                |
| Block import целиком                             |         7,679 | Включает verification, transition, запись и сопутствующую работу |
| ↳ import core / state root                       | 0,111 / 0,620 | Не прибавлять к строке import                                    |
| Envelope processing целиком                      |         3,489 | Не складывать с внутренним newPayload RPC                        |
| Unaggregated attestation verification, 64 вызова |         7,678 | Внутри BLS timer 7,593; это не ещё одна независимая сумма        |
| Aggregated attestation verification, 64 вызова   |         1,878 | Отдельные aggregate/proof проверки                               |
| Sync pool application, 16384 вызова              |         2,527 | Внутри insert 1,538 и aggregation 0,933                          |

Production для блока возвращает unsigned block до подписания и публикации/import того же блока:
[block_service.rs:614](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/validator_client/validator_services/src/block_service.rs#L614),
[sign_and_publish_block:532](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/validator_client/validator_services/src/block_service.rs#L532).
Поэтому production + import — разные последовательные этапы текущего same-slot пути, примерно 14,948
мс в этом окне. Это **не физический нижний предел** нового алгоритма: верхние timers содержат
ожидания и повторную работу. Но измерения уже показывают, что ускорение только sync не является
доказательством целевого бюджета.

`newPayload`, `getPayload`, `forkchoiceUpdated`, envelope, fork-choice, API и VC service timers
частично вложены или перекрываются. Сумма latency всех VC signing jobs — не последовательное время.
Sync per-message signature timer всего 0,142 мс/слот не означает дешёвую batch64: batch выполняется
**до** этих timers, в
[http_api/sync_committees.rs:186](../.cache/warp-native/gloas/beacon_node/http_api/src/sync_committees.rs#L186),
[panda_sync_batch.rs:8](../.cache/warp-native/gloas/beacon_node/beacon_chain/src/panda_sync_batch.rs#L8),
а последующие проверки используют positive cache. По имеющимся counters стоимость самой batch64
внутри сети не отделена.

Старый honest-v3 [phase trace](../reports/warp-tdd/native/critical-path-gloas-honest-v3.json) не
является direct-sync trace. `clock`/`mark`/`consistency` замеряются внутри `move`
([инструментация](../reports/warp-tdd/profile_phases.ts#L19)); их нельзя складывать с phase totals
или переносить 13,53 мс clock/слот как нижнюю границу новой сети.

## Тонкие алгоритмические резервы

1. **Один aggregate — одна обычная BLS-проверка.** Full helper пока вызывает general randomized
   batch даже для одного элемента. При одном уравнении нет cancellation между разными участниками
   batch: обычный `Signature::verify(true, root, DST, [], aggregate_pk, false)` проверяет ту же
   подпись, включая subgroup. Public aggregate PK должен быть построен из проверенных точных
   позиций; infinity/zero сохраняют обычное отклонение. Для нескольких групп остаётся randomized
   batch. В одном candidate отчёте general verify = 1,126787 мс, следующий excluded ordinary oracle
   = 0,773787 мс. Разность **0,353 мс — ориентир**, не controlled A/B: порядок замера различается.
   Даже гипотетическое устранение ВСЕЙ required verification освобождает только 1,127026 мс этого
   компонента. Это самый маленький следующий crypto experiment, без нового helper/store/API.

2. **Не складывать 512 public keys заново при всех установленных sync bits.**
   [sync_aggregate_signature_set:794](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/state_processing/src/per_block_processing/signature_sets.rs#L794)
   сейчас выбирает все 512 PK, а
   [verify_signature_sets:36](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/crypto/bls/src/impls/blst.rs#L36)
   снова суммирует их. В консенсусном состоянии уже есть `SyncCommittee.aggregate_pubkey`,
   вычисленный с кратностями при
   [get_next_sync_committee:1769](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/types/src/state/beacon_state.rs#L1769).
   Узкая ветка all-bits может использовать именно этот public key с обычной декомпрессией/проверкой;
   partial/empty bits сохраняют старый путь. Нужен exact committee из inclusion-slot epoch, а
   signing domain по предыдущему слоту остаётся прежним. Cold 512-PK aggregation в harness занимает
   0,233208 мс; это оценка масштаба резерва, не доказанная native экономия и не строгая граница.
   Никакого изменения state machine или secret cache для этого не нужно.

3. **Повторная проверка полностью одинакового crypto tuple.** Нынешний positive cache хранит
   `(domain-bound signing root, canonical PK, canonical signature)` только после успешной проверки
   ([panda_verified_signature.rs:13](../.cache/warp-native/gloas/crypto/bls/src/impls/panda_verified_signature.rs#L13)).
   Но bulk block verifier его не читает. После group admission тот же sync tuple проверяется опять в
   `include_sync_aggregate`; RANDAO также проверяется при production и bulk import. Узкое расширение
   — lookup известных tuple перед существующим batch, batch только misses, remember только после
   успеха всего batch. Все membership/root/time/state проверки по-прежнему выполняются. Ключ
   aggregate PK должен сначала быть выведен из точных positions; cache не доказывает membership.
   Proposer signature повторно не считать: upstream уже исключает её после gossip в
   [from_gossip_verified_block:1210](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/beacon_node/beacon_chain/src/block_verification.rs#L1210).
   Непроверенный резерв: отдельного bulk setup/crypto timer и hit/miss evidence сейчас нет.
   Стоимость single pairing нельзя объявить marginal стоимостью элемента общего batch.

## Почему SSZ macro-step не закрывает разрыв

Gloas production делает настоящий transition и state root
([gloas.rs:809](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/beacon_node/beacon_chain/src/block_production/gloas.rs#L809));
import повторяет transition без уже проверенных signatures и сверяет root
([block_verification.rs:1666](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/beacon_node/beacon_chain/src/block_verification.rs#L1666)).
Это реальное повторение. Но `update_tree_hash_cache` уже применяет pending changes к persistent
структурам
([beacon_state.rs:3030](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/types/src/state/beacon_state.rs#L3030)),
а не заново сериализует и хэширует весь state.

Даже идеальное переиспользование результата producer вместо повторных import core + root устранило
бы около **0,731 мс/слот** в измеренном окне. Все два root timers вместе — 1,219 мс/слот; убрать их
оба нельзя, сохраняя обычную историю. Для безопасного результата-cache понадобились бы точный
pre-state root, полный block input, fork/spec и сохранённый post-state, проверенные signature/EL
results и fallbacks. Ради такого ограниченного резерва это не первый тонкий шаг.

Даже без пользовательских tx каждый следующий блок зависит от предыдущего state/block root, RANDAO,
rewards/participation и execution data. `per_slot_processing::cache_state` записывает state root и
обновляет block-root историю
([per_slot_processing.rs:121](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/state_processing/src/per_slot_processing.rs#L121)).
Пропуск этих корней по формуле меняет обычную проверяемую историю. Начальное состояние и целевое
время не задают конечный root без выполнения этих зависимостей.

## Какой вывод допускает бюджет

Условная сумма group component + production process/root + import core/root составляет **3,888
мс/слот**. Это только неполный список работ из разных замеров, не прогноз и не нижняя граница: в нём
отсутствуют обязательные оставшиеся подписи и проверки, EL, envelope, история, финальность, границы
эпох и первая tx. До номинальных 7,324 мс остаётся лишь 3,436 мс на всё это.

Следующий обоснованный маленький опыт — one-signature ordinary verify против batch1 на тех же
входах, с теми же subgroup/zero/root/domain negatives. Затем нужен native замер интегрированного
group path с **раздельными невложенными** crypto setup/verify, state mutation/hash и обязательными
request стадиями. Существующие histograms не дают такой раскладки. Для positive cache обязательны
контроли mutation PK/root/signature, eviction/reverify, failed batch без warmed prefixes и
компенсирующие ошибки. Для aggregate PK — all/partial/empty bits, повторяющиеся ключи, переход
комитета и infinity. Эти дополнительные сценарии пока не выполнены.

Тонкий алгоритм, уже доказанно обеспечивающий целые 8192 слота с первой tx за 60 с, **не найден**.
Известные повторные PK/hash вычисления имеют резерв порядка долей миллисекунды; объявлять их
решением оставшегося десятков-миллисекундного разрыва оснований нет.
