# zap-net

Локальный Pectra devnet: Geth + Lighthouse beacon node + validator client, один контроллер
Deno/TypeScript, Docker через dockerode. Genesis создаёт одноразовый ethereum-genesis-generator.
Статус проверок и замеры — в [docs/measurements.md](docs/measurements.md). Выполненные пункты и
следующие этапы — в [плане проекта](docs/plan.md).

```sh
sh scripts/bootstrap.sh
./scripts/deno run -A scripts/prepare_clients.ts
deno task build:clients        # отдельно; первоначальная сборка длительная
deno task smoke:docker
deno task up                   # foreground, Ctrl-C очищает ресурсы этого стенда
```

Задачи запускают локальный Deno 2.9.7 из `.tools`: системный Deno служит только для `deno task`.
`deno.json` содержит совместимый список задач, `deno.runtime.json` — зависимости и рабочие
настройки.

В другом терминале: `deno task down` или `deno task reset`. `ZAP_ID` выбирает стенд (по умолчанию
`local`), `ZAP_PORT` — порт контроллера (8545). Docker socket:
`ZAP_DOCKER_SOCKET=/path/to/docker.sock` либо `DOCKER_HOST=unix:///path/to/docker.sock`. Docker
Desktop на macOS определяется автоматически. Удалённый Docker daemon пока не поддерживается:
используются локальные bind mounts. Публичные RPC и Beacon API привязаны к 127.0.0.1. Внутренний
Engine-прокси принимает соединения контейнеров через host gateway и проверяет JWT; см.
[архитектуру](docs/architecture.md).

JSON-RPC доступен на корне адреса контроллера; стандартные пути Beacon API `/eth/v1/...` и
`/eth/v2/...` — на том же адресе. Automine изначально выключен. Ключи и mnemonic публичные,
предназначены только для этого локального стенда.

```ts
import { Devnet } from "./src/api.ts";

await using net = await Devnet.start({ id: "my-e2e" });
const initial = await net.status();
await net.stepSlot();
await net.advanceEpochs(2);
await net.advanceTime(3600); // час протокольного времени с блоками и голосами
await net.advanceTo(new Date((initial.now + 7200) * 1000));
await net.setAutomine(true);
// eth_sendRawTransaction возвращает обычный tx hash; receipt ожидается отдельно.
await net.advanceUntil(
  async () => BigInt((await net.status()).finality.data.finalized.epoch) >= 3n,
  { maxSlots: 160 },
);
```

К уже работающему контроллеру: `new Devnet("http://127.0.0.1:8545")`. `close()`/`await using`
останавливают только стенд, созданный этим объектом; подключение к чужому контроллеру не получает
владение его жизненным циклом.

`advanceTime` принимает секунды с точностью до миллисекунды; `advanceTo` — Unix timestamp в секундах
или `Date`. Часы движутся только вперёд. Команда исполняет все фазы до указанного момента; если
момент внутри слота, следующие обязанности ожидают следующего продвижения. `stepSlot` и
`advanceSlots` завершают слоты на фазе 11,5 с. Начальная пауза — genesis + 11,5 с, до первого
предложения блока в слоте 1. Протокольные слоты сохраняют длину 12 секунд.

`skipSlots(n)` явно пропускает слоты без блоков/attestations. Это может ухудшать участие,
задерживать финализацию и вызывать inactivity penalties. VC перезапускается с сохранением ключей и
slashing protection; state transitions выполняет Lighthouse при последующей обработке состояния. Для
обычной перемотки используйте `advanceTime`/`advanceTo`.

По умолчанию genesis timestamp = 2 000 000 000 (2033 год): это намеренная проверка будущего времени
относительно хоста. Можно задать `genesisTime` в `Devnet.start`. Mainnet preset: 32 слота/эпоху, 64
genesis validators, обычные параметры churn, активации и withdrawals; fork Electra/Prague активен с
genesis. Число genesis validators уменьшено явно. Профиля `minimal` нет.

```sh
deno task test                         # быстрые unit checks, Docker/e2e помечены skipped
ZAP_DOCKER_TEST=1 deno task test        # проверка rollback и защиты чужих ресурсов
ZAP_E2E=1 deno task test                # все четыре реальных e2e последовательно; нужен образ
deno task e2e                          # время, automine, финализация, отдельный индексатор
deno task e2e:withdrawal               # реальный exit → withdrawal через сотни эпох
deno task e2e:protocol                 # депозит, активация, consolidation с явным churn override
deno task e2e:deploy                   # 20 последовательных деплоев через RPC и ethers
deno task test:lifecycle               # повторные up/down/reset и воспроизводимый genesis
deno task test:clock                   # Rust regression часов; использует build cache
deno task measure                      # два свежих стенда, CPU/RAM/диск/скорость
deno task diagnose
deno task profile                     # работающий стенд; продвигает 32 слота
deno task check
```

Для последовательного деплоя включите `await net.setAutomine(true)`, дождитесь receipt предыдущей
транзакции и отправляйте следующую. Automine сам производит следующий блок; вызывать `stepSlot` или
делать `sleep` между транзакциями не требуется. Каждый блок всё равно проходит настоящую обработку
EL/CL, поэтому ненулевая вычислительная задержка остаётся.

При использовании ethers настройте ожидание receipt для быстрого локального стенда:

```ts
import { JsonRpcProvider, NonceManager, Wallet } from "ethers";
import { privateKey } from "./src/config.ts";

const provider = new JsonRpcProvider(net.url, 1337, {
  staticNetwork: true, // у этого стенда фиксированный chainId
  pollingInterval: 25,
  cacheTimeout: -1,
  batchMaxCount: 1,
});
const signer = new NonceManager(new Wallet(privateKey, provider));
// new ContractFactory(abi, bytecode, signer).deploy(...)
// await contract.waitForDeployment() перед следующим зависимым деплоем.
// По завершении работы вызовите provider.destroy().
```

Polling и batching — параметры клиента; они не меняют протокольную длину слота. Кэш запросов
отключён, чтобы последовательные операции не видели устаревший nonce или номер блока. См.
[параметры ethers](https://docs.ethers.org/v6/api/providers/jsonrpc/#JsonRpcApiProviderOptions). В
[примере деплоя](examples/deploy.ts) проверяются конструктор, runtime-код и непрерывная
последовательность блоков; отдельные задержки сохраняются в `reports/deploy.json`.

`advanceUntil` имеет предел слотов и реальное время ожидания. Ошибка внутри фазы не откатывает
клиентов: дальнейшее продвижение блокируется до reset, чтобы не продолжать с неопределённым
состоянием. Независимые запросы и сетевые watchdog остаются на реальном времени. Внешний сервис
видит продвинутые timestamps блоков; его собственные системные часы не меняются.

Исходники форка, сборочные артефакты и состояние стендов лежат в `.cache/`, `.tools/`, `.zap/` и не
коммитятся. Образы и volumes `zap-build-*` — отдельный повторно используемый build cache.
`down/reset` очищают ресурсы только выбранного `ZAP_ID`. Глобальный Docker prune не используется.

В примере consolidation задан `churnLimitQuotient: 4`: с 64 валидаторами стандартный churn не
оставляет ёмкости для consolidation. Это явное отличие тестового профиля; по умолчанию quotient =
65536. Полный пример выхода сохраняет стандартные задержки и использует явный `skipSlots` для
длинных периодов без блоков. После пропусков действуют настоящие штрафы за неучастие.

Geth используется без форка. Для управляемого производства блоков тот же Deno-процесс содержит
Engine-прокси: он откладывает подготовку будущего payload и ждёт завершения сборки текущего по
JSON-логу закреплённого Geth. При обновлении Geth эту зависимость нужно проверить заново.
[Результаты ревью](docs/review.md) описывают найденные дефекты и проверки исправлений.

Поддерживается HTTP JSON-RPC. WebSocket, длительный Beacon SSE, несколько BN и произвольные внешние
валидаторы в этой версии не проверены/не поддерживаются. После аварийного завершения выполните
`deno task down`, затем `deno task up`: продолжение старого состояния после перезапуска контроллера
пока не реализовано. На паузе real-time txpool expiry Geth продолжает действовать.
