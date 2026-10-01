# Два режима перемотки

Пошаговое описание для разработчика: [How protocol time and warp work](warp-algorithm.md). Ниже —
выбор режима, измерения и границы проверки.

Решение пользователя от 2026-09-30: закончить оптимизации и сохранить простой проверенный путь
`direct-sync`. Предыдущие исследования и все измерения сохранены в
[журнале экспериментов](warp-experiments.md). Групповой signer, MSM и shared-H в клиент не включены.

```ts
await net.advanceTime(8192 * 12); // honest по умолчанию
await net.advanceTime(8192 * 12, { mode: "honest" });
await net.advanceTime(8192 * 12, { mode: "fast" });
await net.advanceTo(targetDate, { mode: "fast" });
```

|             | Honest                                            | Fast                                                         |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------ |
| История     | Все промежуточные блоки и обязанности             | Пропущенный диапазон и настоящий блок назначения             |
| Экономика   | Обычное участие; искусственных пропусков нет      | Реальные штрафы за неучастие и потеря rewards                |
| Финальность | Продвигается во время диапазона                   | Может отстать; восстанавливается следующими честными слотами |
| Слэшинг     | Недопустим                                        | Недопустим; база защиты сохраняется при перезапуске VC       |
| Скорость    | Gloas около 13 минут на 8192, историческая оценка | Секунды; regression gate 25 с вместе с первой следующей tx   |

Режим выбирается для каждого вызова. Малые fast-переходы до 32 слотов выполняются обычным путём. В
большом fast-переходе завершаются текущие duties, VC останавливается, BN проходит настоящие переходы
пустых слотов, VC запускается с прежними ключами/slashing DB, затем создаётся блок в целевом слоте.
Точное время назначения, в том числе середина слота, сохраняется. `advanceSlots`, `advanceEpochs`,
`stepSlot` и automine всегда выполняют обязанности; `skipSlots` остаётся явным простоем без создания
целевого блока.

Одна очередь сериализует оба режима. Ошибка после частичного продвижения блокирует последующие
изменения времени до reset. Неверный mode отвергается до продвижения.

## Какой клиент оставлен

Gloas `direct-sync`, key `e41c863be72847fb1bec8e0b455e23f243cb27d8e73d3ce90ea8f5be6e78c0c8`, CL
image `sha256:6964cab3bb40072d63e87cf08fa9b6e992195aeeeff9271f970bd931d14bfe08`. Все восемь
native-файлов совпали с исходниками этого immutable bake:
[проверка hashes](../reports/warp-modes/baseline.json). Новый выбор режима реализован только в
TypeScript; EL/CL не переписывались и не пересобирались. Оба режима работают на одном bake.

Pectra проверяется независимо на ранее собранном `panda`, key `96b5d5a…`. Это существующий клиент с
обычными индивидуальными duties; новый Pectra direct-sync bake не собирался. Его скорость нельзя
выводить из Gloas.

## Проверки

- Поведенческий RED перед implementation: fast ещё выполнял все слоты, неизвестные modes не
  отвергались; затем time/API GREEN. Проверены точная дата, partial slot, малые fast до 32 слотов,
  смешанная очередь, сохранение честного default и отказ после частичного skip.
- Profile routing RED→GREEN: оба профиля отдельно содержат `warp-fast`, `warp` и `warp-economics`.
- Pruning RED→GREEN: rewards читаются во время продвижения по мере закрытия эпох; они больше не
  запрашиваются впервые после всего длинного диапазона. Это исправление тестового наблюдателя.
  Отсутствующее доказательство остаётся ошибкой, не трактуется как отсутствие штрафов.
- Полный unit-набор: 42 passed, 0 failed, 13 opt-in ignored. Localhost API проверен отдельно;
  первоначальный sandbox bind error не является behavior RED.

| Реальный сценарий                                                                        | Артефакт            | Результат                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| Fast: два ×8192, первая tx, resumed finality и signing history                           | Gloas `direct-sync` | PASS, 8,286 / 8,633 с вместе с tx; все 64 unslashed                                  |
| Fast: два ×8192, первая tx, resumed finality и signing history                           | Pectra `panda`      | PASS, 15,181 / 15,510 с вместе с tx; все 64 unslashed                                |
| Honest: два ×96, live rewards, все sync bits, история подписей и tx                      | Gloas `direct-sync` | PASS, 8,592 / 8,662 с вместе с tx                                                    |
| Honest economics: два ×96, participation/rewards, sync/PTC, deploy и missing-key failure | Gloas `direct-sync` | PASS; advance 8,526 / 8,490 с, deploy 0,106 / 0,100 с; отказ missing key за 30,078 с |
| Honest economics: два ×96, participation/rewards, sync и deploy                          | Pectra `panda`      | PASS; advance 32,223 / 32,039 с, deploy 0,371 / 0,466 с                              |
| Два полных honest ×8192                                                                  | Gloas/Pectra        | В этом изменении не запускались; полного PASS нет                                    |

Сырые команды, RED/GREEN и логи: [reports/warp-modes](../reports/warp-modes/). Это targeted
проверки, а не новый успешный `test:profile` или ручное изменение `verification.json`. Старый
длинный Gloas run завершился ошибкой historical rewards после 12m40s; точное время самого advance
тогда не было сохранено. Прогноз около 13 минут подтверждается коротким старым замером, но не
является новым полным успешным benchmark.

```sh
PANDA_PROFILE=gloas PANDA_BAKE=direct-sync ./scripts/deno task e2e:warp-fast
PANDA_PROFILE=pectra PANDA_BAKE=panda ./scripts/deno task e2e:warp-fast
PANDA_PROFILE=gloas PANDA_BAKE=direct-sync ./scripts/deno task e2e:warp-economics
# Долгий сценарий: два honest диапазона по 8192, ориентировочно десятки минут целиком.
PANDA_PROFILE=gloas PANDA_BAKE=direct-sync ./scripts/deno task e2e:warp
```

Fast имеет deadline 25 с для скачка с первой tx. Honest имеет отдельный watchdog на sample: 20 минут
для Gloas и 55 минут для более медленного старого Pectra bake и сохраняет проверки экономики/full
coverage. Полная матрица deposit, activation, exit, consolidation, очередей и injected failures
через honest warp ещё не закрыта; см. [критерии](warp-tdd-acceptance.md). Ни скорость fast, ни
`slashed == false` её не заменяют.
