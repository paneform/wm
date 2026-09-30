import { error } from "@sveltejs/kit";
import { commandDocs } from "@paneform/layout";
import type { PageLoad } from "./$types";

export const load: PageLoad = ({ params }) => {
  const doc = commandDocs.find((item) => item.slug === `${params.domain}/${params.slug}`);
  if (!doc) error(404, "Unknown command");
  return { doc };
};
