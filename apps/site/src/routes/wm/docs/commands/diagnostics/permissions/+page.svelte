<p class="docs-breadcrumb">Docs / Commands / Diagnostics / permissions</p>
<h1>wm permissions</h1><p class="lede">Check your local macOS permissions. This read-only command runs locally without contacting the daemon.</p>
<h2 id="invocation">Invocation</h2><table><tbody><tr><th>Method</th><th>Invocation</th></tr><tr><td data-label="Method"><span class="method">CLI</span></td><td data-label="Invocation"><code>wm permissions</code></td></tr></tbody></table>
<h2 id="result">Result</h2><p>Reports permission states as JSON. If a permission is missing, run <code>wm permissions request</code> and check again.</p>
<p>Add <code>--verbose</code> to include the full report and sidecar diagnostics.</p>
<h2 id="sample">Sample run</h2><DoctorTranscript />
<h2 id="related">Related</h2><div class="related"><a href="/wm/docs/getting-started/">Installation<small>Set up and verify the service</small></a></div>
<script lang="ts">import DoctorTranscript from "$lib/docs/DoctorTranscript.svelte";</script>
