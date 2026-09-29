import { dirname } from "node:path";

const root = `${Deno.cwd()}/.cache/upstream/lighthouse`;
const commit = "cfb1f7331064b758c6786e4e1dc15507af5ff5d1";
async function git(args: string[], cwd = Deno.cwd()): Promise<string> {
  const result = await new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" })
    .output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
try {
  await Deno.stat(`${root}/.git`);
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
  await Deno.mkdir(dirname(root), { recursive: true });
  await git([
    "clone",
    "--depth",
    "1",
    "--branch",
    "v7.1.0",
    "https://github.com/sigp/lighthouse.git",
    root,
  ]);
}
if (await git(["rev-parse", "HEAD"], root) !== commit) {
  throw new Error("Unexpected Lighthouse source commit");
}
const patch = `${Deno.cwd()}/clients/lighthouse.patch`;
try {
  await git(["apply", "--reverse", "--check", patch], root);
} catch {
  await git(["apply", "--check", patch], root);
  await git(["apply", patch], root);
}
await Deno.copyFile("clients/controlled_clock.rs", `${root}/common/slot_clock/src/controlled.rs`);
await Deno.mkdir(`${root}/common/slot_clock/tests`, { recursive: true });
await Deno.copyFile(
  "clients/controlled_clock_test.rs",
  `${root}/common/slot_clock/tests/controlled.rs`,
);
console.log(JSON.stringify({ event: "sources-ready", commit, root }));
