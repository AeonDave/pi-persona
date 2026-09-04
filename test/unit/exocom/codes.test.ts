import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
	MAX_JOIN_CODE_ATTEMPTS,
	allocateJoinCode,
	candidateJoinCode,
	encodeJoinCode,
	isJoinCode,
	joinCodePath,
	joinCodeReservationPath,
	resolveJoinCode,
	validateJoinCode,
} from "../../../src/exocom/codes.ts";

const SCOPE_A = "0123456789abcdef01234567";
const SCOPE_B = "89abcdef0123456789abcdef";
const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function agentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "exo-codes-"));
	dirs.push(dir);
	return dir;
}

test("join codes are exactly case-sensitive Base62", () => {
	assert.equal(isJoinCode("0aZ9"), true);
	assert.equal(isJoinCode("0az9"), true);
	assert.equal(isJoinCode("0aZ"), false);
	assert.equal(isJoinCode("0aZ90"), false);
	assert.equal(isJoinCode("0a-9"), false);
	assert.equal(isJoinCode("0a z"), false);
	assert.equal(isJoinCode(undefined), false);
	assert.equal(validateJoinCode("0aZ9"), "0aZ9");
	assert.equal(encodeJoinCode("0aZ9"), "30615a39");
	assert.throws(() => validateJoinCode("0az"), /four Base62/i);
});

test("candidate generation is deterministic, bounded, and aliases the full scope id", () => {
	const first = candidateJoinCode(SCOPE_A, 0);
	assert.equal(first, candidateJoinCode(SCOPE_A, 0));
	assert.equal(first.length, 4);
	assert.equal(isJoinCode(first), true);
	assert.notEqual(first, candidateJoinCode(SCOPE_A, 1));
	assert.notEqual(first, candidateJoinCode(SCOPE_B, 0));
	assert.throws(() => candidateJoinCode("not-a-scope", 0), /24-hex/i);
	assert.throws(() => candidateJoinCode(SCOPE_A, MAX_JOIN_CODE_ATTEMPTS), /attempt/i);
});

test("allocation persists under agentDir and resolves back to the full scope id", async () => {
	const root = await agentDir();
	const code = allocateJoinCode(root, SCOPE_A);
	assert.equal(isJoinCode(code), true);
	assert.equal(resolveJoinCode(root, code), SCOPE_A);
	assert.equal(allocateJoinCode(root, SCOPE_A), code, "the scope keeps its alias");
	const path = joinCodePath(root, code);
	assert.equal(existsSync(path), true);
	assert.equal(lstatSync(path).isFile(), true);
	assert.doesNotMatch(path, new RegExp(code), "mixed-case code is not used as a filename");
	assert.match(path, /[0-9a-f]{8}\.json$/);
	// Durable aliases are the one part of the exocom tree nothing can reconstruct, so pin the
	// directory they live in: `<agentDir>/persona/exocom/codes`, alongside the registry scopes.
	assert.equal(dirname(path), join(root, "persona", "exocom", "codes"));
	assert.equal(dirname(joinCodeReservationPath(root, code)), join(root, "persona", "exocom", "codes", ".used"));
});

test("a deterministic candidate collision probes the next candidate without recycling aliases", async () => {
	const root = await agentDir();
	const first = candidateJoinCode(SCOPE_B, 0);
	const second = candidateJoinCode(SCOPE_B, 1);
	const occupied = joinCodePath(root, first);
	mkdirSync(join(occupied, ".."), { recursive: true });
	writeFileSync(occupied, JSON.stringify({ version: 1, code: first, scope_id: SCOPE_A }));
	const code = allocateJoinCode(root, SCOPE_B);
	assert.equal(code, second);
	assert.equal(resolveJoinCode(root, code), SCOPE_B);
	assert.equal(resolveJoinCode(root, first), SCOPE_A);
});

test("malformed, linked, and oversized mappings fail closed", async () => {
	const root = await agentDir();
	const malformed = candidateJoinCode(SCOPE_A, 0);
	const malformedPath = joinCodePath(root, malformed);
	mkdirSync(join(malformedPath, ".."), { recursive: true });
	writeFileSync(malformedPath, "not json\n");
	assert.equal(resolveJoinCode(root, malformed), undefined);

	const linked = candidateJoinCode(SCOPE_A, 1);
	const linkedPath = joinCodePath(root, linked);
	const target = join(root, "target.json");
	writeFileSync(target, JSON.stringify({ code: linked, scope_id: SCOPE_A }));
	symlinkSync(target, linkedPath);
	assert.equal(resolveJoinCode(root, linked), undefined);

	const oversized = candidateJoinCode(SCOPE_A, 2);
	const oversizedPath = joinCodePath(root, oversized);
	writeFileSync(oversizedPath, "x".repeat(65 * 1024));
	assert.equal(resolveJoinCode(root, oversized), undefined);
});

test("allocation does not reuse a reserved alias after its mapping disappears", async () => {
	const root = await agentDir();
	const first = allocateJoinCode(root, SCOPE_A);
	const firstPath = joinCodePath(root, first);
	await rm(firstPath);
	const second = allocateJoinCode(root, SCOPE_B);
	assert.notEqual(second, first);
	assert.equal(resolveJoinCode(root, second), SCOPE_B);
});

test("a same-scope reservation recovers its missing mapping instead of allocating a second alias", async () => {
	const root = await agentDir();
	const code = candidateJoinCode(SCOPE_A, 0);
	const reservation = joinCodeReservationPath(root, code);
	mkdirSync(join(reservation, ".."), { recursive: true });
	writeFileSync(reservation, JSON.stringify({ version: 1, code, scope_id: SCOPE_A }));
	assert.equal(existsSync(joinCodePath(root, code)), false);
	assert.equal(allocateJoinCode(root, SCOPE_A), code);
	assert.equal(resolveJoinCode(root, code), SCOPE_A);
	assert.notEqual(allocateJoinCode(root, SCOPE_B), code, "another scope cannot reuse the recovered alias");
});

test("different and legacy reservations remain occupied", async () => {
	const root = await agentDir();
	const foreignCode = candidateJoinCode(SCOPE_B, 0);
	const foreignReservation = joinCodeReservationPath(root, foreignCode);
	mkdirSync(join(foreignReservation, ".."), { recursive: true });
	writeFileSync(foreignReservation, JSON.stringify({ version: 1, code: foreignCode, scope_id: SCOPE_A }));
	assert.throws(() => allocateJoinCode(root, SCOPE_B, { maxAttempts: 1 }), /unable to allocate/i);

	const legacyCode = candidateJoinCode(SCOPE_A, 0);
	const legacyReservation = joinCodeReservationPath(root, legacyCode);
	writeFileSync(legacyReservation, JSON.stringify({ version: 1, code: legacyCode }));
	assert.equal(allocateJoinCode(root, SCOPE_A, { maxAttempts: 2 }), candidateJoinCode(SCOPE_A, 1));
});
