import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import { suiteHash } from "../src/verification.ts";

Deno.test("immutable bake verification ignores other profiles, new build recipes and unrelated tests", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (
      const path of [
        "src",
        "scripts",
        "examples",
        "profiles",
        "tests",
        "deno.runtime.json",
        "deno.lock",
      ]
    ) {
      await cp(path, `${root}/${path}`, { recursive: true });
    }
    const pectra = () => suiteHash({ profile: "pectra" }, root);
    const gloas = () => suiteHash({ profile: "gloas" }, root);
    const before = { pectra: await pectra(), gloas: await gloas() };
    await Deno.writeTextFile(`${root}/examples/gloas.ts`, "\n// new Gloas assertion\n", {
      append: true,
    });
    assert.equal(await pectra(), before.pectra);
    assert.notEqual(await gloas(), before.gloas);
    const changedGloas = await gloas();
    for (const profile of ["pectra", "gloas"]) {
      const path = `${root}/profiles/${profile}.json`;
      const recipe = JSON.parse(await Deno.readTextFile(path));
      recipe.clRef = "a-different-client-for-a-future-bake";
      recipe.patch = "clients/a-new-patch.patch";
      await Deno.writeTextFile(path, JSON.stringify(recipe));
    }
    await Deno.mkdir(`${root}/clients`);
    await Deno.writeTextFile(`${root}/clients/controlled_clock.rs`, "new clock source");
    await Deno.writeTextFile(`${root}/tests/profiles_test.ts`, "new baker unit test");
    await Deno.writeTextFile(`${root}/src/baker.ts`, "new build implementation");
    assert.equal(await pectra(), before.pectra);
    assert.equal(await gloas(), changedGloas);
    const defaultsPath = `${root}/profiles/pectra.json`;
    const defaults = JSON.parse(await Deno.readTextFile(defaultsPath));
    defaults.churnLimitQuotient = 4;
    await Deno.writeTextFile(defaultsPath, JSON.stringify(defaults));
    assert.notEqual(await pectra(), before.pectra);
    assert.equal(await gloas(), changedGloas);
    defaults.churnLimitQuotient = 65536;
    await Deno.writeTextFile(defaultsPath, JSON.stringify(defaults));
    assert.equal(await pectra(), before.pectra);
    await Deno.writeTextFile(
      `${root}/examples/validators.ts`,
      "\n// shared validator assertion\n",
      { append: true },
    );
    assert.notEqual(await pectra(), before.pectra);
    const shared = await pectra();
    await Deno.writeTextFile(`${root}/src/time.ts`, "\n// changed shared timeline\n", {
      append: true,
    });
    assert.notEqual(await pectra(), shared);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
