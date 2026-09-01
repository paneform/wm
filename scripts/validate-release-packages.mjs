import { readFile } from "node:fs/promises";

const [expectedVersion, layoutPath, browserPath] = process.argv.slice(2);
if (expectedVersion === undefined || layoutPath === undefined || browserPath === undefined) {
  throw new Error(
    "usage: validate-release-packages <version> <layout-manifest> <browser-manifest>",
  );
}

const readManifest = async (path) => JSON.parse(await readFile(path, "utf8"));
const [layout, browser] = await Promise.all([readManifest(layoutPath), readManifest(browserPath)]);

const assertPackage = (packageJson, expectedName) => {
  if (packageJson.name !== expectedName)
    throw new Error(`expected ${expectedName}, got ${packageJson.name}`);
  if (packageJson.version !== expectedVersion) {
    throw new Error(`${expectedName} is ${packageJson.version}; expected ${expectedVersion}`);
  }
  if (JSON.stringify(packageJson).includes("workspace:")) {
    throw new Error(`${expectedName} contains a workspace dependency`);
  }
  for (const hook of ["preinstall", "install", "postinstall"]) {
    if (packageJson.scripts?.[hook] !== undefined) {
      throw new Error(`${expectedName} contains an install-time ${hook} script`);
    }
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, specifier] of Object.entries(packageJson[field] ?? {})) {
      if (/^(?:file:|git(?:\+|:)|https?:|github:|npm:)/.test(specifier)) {
        throw new Error(`${expectedName} has unsafe ${field} entry ${name}@${specifier}`);
      }
    }
  }
};

assertPackage(layout, "@paneform/layout");
assertPackage(browser, "@paneform/layout-browser");

if (layout.exports?.["."]?.import !== "./dist/index.js") {
  throw new Error("@paneform/layout root export does not use dist");
}
if (layout.exports?.["./testing"]?.import !== "./dist/testing.js") {
  throw new Error("@paneform/layout testing export does not use dist");
}
if (browser.exports?.["."]?.import !== "./dist/index.js") {
  throw new Error("@paneform/layout-browser root export does not use dist");
}
const escapedVersion = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const peerPattern = new RegExp(`^>=${escapedVersion} <([1-9]\\d*)$`);
const peerRange = browser.peerDependencies?.["@paneform/layout"];
const upperMajor = peerPattern.exec(peerRange)?.[1];
const releaseMajor = Number(expectedVersion.split(".")[0]);
if (upperMajor === undefined || Number(upperMajor) <= releaseMajor) {
  throw new Error(`@paneform/layout-browser peer range ${peerRange} does not include this release`);
}
