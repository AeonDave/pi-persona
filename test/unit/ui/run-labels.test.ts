import test from "node:test";
import assert from "node:assert/strict";
import { buildRunLabelDetails, parseRunLabelDetails } from "../../../src/ui/run-labels.ts";

test("run label snapshots preserve assigned names without model metadata", () => {
	const details = buildRunLabelDetails([{ id: "run-1", agent: "operator", label: "Moss" }]);
	assert.equal(parseRunLabelDetails(details).get("run-1"), "Moss");
	assert.equal(parseRunLabelDetails({ runLabels: [{ id: "run-2", label: 3 }] }).size, 0);
});

test("same-named workers retain unique routing IDs in their display labels", () => {
	const map = parseRunLabelDetails(buildRunLabelDetails([{ id: "run-1", agent: "operator", label: "Moss" }, { id: "run-2", agent: "operator", label: "Moss" }]));
	assert.equal(map.get("run-1"), "Moss [run-1]");
	assert.equal(map.get("run-2"), "Moss [run-2]");
});
