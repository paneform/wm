<script lang="ts">
  import SharedDockIcon from "../desktop/DockIcon.svelte";
  import type { HeroAppIcon } from "./hero-model.js";

  let { icon }: { icon: HeroAppIcon } = $props();
</script>

<SharedDockIcon {icon} />
