import assert from "node:assert/strict";

Deno.test("release checkouts do not leave GitHub credentials in the workspace", async () => {
  for (const name of ["images", "lighthouse", "release-tag", "release"]) {
    const source = await Deno.readTextFile(`.github/workflows/${name}.yml`);
    const checkouts = [...source.matchAll(
      /^ {6}- uses: actions\/checkout@[a-f0-9]{40}[^\n]*\n(?:(?! {6}- )[^\n]*\n)*/gm,
    )];
    assert(checkouts.length > 0, `${name}: missing pinned checkout`);
    for (const [checkout] of checkouts) {
      assert.match(checkout, /^ {10}persist-credentials: false$/m, name);
    }
    assert.doesNotMatch(source, /\bself-hosted\b|^\s+pull_request_target:/m, name);
  }
});
