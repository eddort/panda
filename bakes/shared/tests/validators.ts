import { Devnet } from "../../../src/api.ts";
import { json } from "../../../src/http.ts";
import { Network } from "../../../src/network.ts";

export interface ValidatorRecord {
  index: string;
  balance: string;
  status: string;
  validator: {
    slashed: boolean;
    pubkey: string;
    exit_epoch: string;
    withdrawable_epoch: string;
    withdrawal_credentials: string;
    activation_epoch: string;
  };
}
export async function validator(net: Devnet, index: number): Promise<ValidatorRecord> {
  return (await net.beacon<{ data: ValidatorRecord }>(
    `/eth/v1/beacon/states/head/validators/${index}`,
  )).data;
}
export async function exitValidator(net: Devnet, index: number): Promise<void> {
  const m = await Network.manifest((await net.status()).id);
  const record = await validator(net, index);
  const token = (await Deno.readTextFile(`${m.directory}/validator-keys/keys/api-token.txt`))
    .trim();
  const signed = await json<{ data: unknown }>(
    `${m.vc}/eth/v1/validator/${record.validator.pubkey}/voluntary_exit`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    },
  );
  const response = await fetch(`${m.beacon}/eth/v1/beacon/pool/voluntary_exits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signed.data),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Exit rejected: ${await response.text()}`);
  await response.body?.cancel();
}
