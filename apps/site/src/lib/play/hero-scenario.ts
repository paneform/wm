import { parseScenario, type LayoutScenario } from "@paneform/layout-browser";
import heroScenarioDocument from "./hero.scenario.json?raw";

export { heroScenarioDocument };

export function parseHeroScenario(): LayoutScenario {
  return parseScenario(JSON.parse(heroScenarioDocument));
}
