import { mount, unmount } from "svelte";
import DemoStage from "./DemoStage.svelte";
import { demosForCommand, type DemoSituation } from "./demo-data.js";

/** Browser-only test fixture: exercise real cards at counts the catalog does not yet contain. */
export function mountCarousel(count: number) {
  const samples = demosForCommand("windows/move-directional")!;
  const situations = Array.from({ length: count }, (_, index) => ({
    ...samples[index % samples.length]!,
    slug: `example-${index}`,
    title: `Example ${index + 1}`,
  }));
  return mountSituations(situations);
}

export function mountCommandDemo(slug: string, situation: string) {
  const examples = demosForCommand(slug)?.filter((item) => item.slug === situation) ?? [];
  if (!examples.length) throw new Error(`Missing test situation ${slug}/${situation}`);
  return mountSituations(examples);
}

function mountSituations(situations: DemoSituation[]) {
  const target = document.createElement("div");
  target.dataset.carouselFixture = "true";
  document.querySelector("#docs-main")!.prepend(target);
  const component = mount(DemoStage, { target, props: { situations } });
  return async () => {
    await unmount(component);
    target.remove();
  };
}
