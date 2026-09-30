import { mount, unmount } from "svelte";
import DemoStage from "./DemoStage.svelte";
import { demosForCommand } from "./demo-data.js";

/** Browser-only test fixture: exercise real cards at counts the catalog does not yet contain. */
export function mountCarousel(count: number) {
  const samples = demosForCommand("windows/move-directional")!;
  const situations = Array.from({ length: count }, (_, index) => ({
    ...samples[index % samples.length]!,
    slug: `example-${index}`,
    title: `Example ${index + 1}`,
  }));
  const target = document.createElement("div");
  target.dataset.carouselFixture = "true";
  document.querySelector("#docs-main")!.prepend(target);
  const component = mount(DemoStage, { target, props: { situations } });
  return async () => {
    await unmount(component);
    target.remove();
  };
}
