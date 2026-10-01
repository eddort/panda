import { Devnet } from "../../../src/api.ts";

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
  const record = await validator(net, index);
  await net.exitValidator(record.validator.pubkey);
}
