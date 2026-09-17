// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert/strict';
import { DebugState } from '../debugState';

suite('Explicit debug execution state (#157)', () => {
	test('defaults to unknown and inactive, including serialized paused status', () => {
		const state = new DebugState();
		assert.equal(state.paused, null);
		assert.equal(state.isPaused(), false);
		assert.equal(JSON.parse(state.toString()).paused, false);
	});

	test('an explicit stop needs neither source nor a frame', () => {
		const state = new DebugState();
		state.sessionActive = true;
		state.paused = true;
		assert.equal(state.isPaused(), true);
		assert.equal(state.hasValidContext(), false);
		assert.equal(state.hasLocationInfo(), false);
		assert.equal(state.frameId, null);
		assert.equal(JSON.parse(state.toString()).paused, true);
	});

	test('unknown state falls back to valid context, including zero IDs', () => {
		const state = new DebugState();
		state.sessionActive = true;
		state.threadId = 0;
		assert.equal(state.isPaused(), false);
		state.frameId = 0;
		assert.equal(state.isPaused(), true);
		assert.equal(state.hasValidContext(), true);
		assert.equal(state.paused, null);
	});

	test('explicit running overrides context without conflating the two predicates', () => {
		const state = new DebugState();
		state.sessionActive = true;
		state.updateContext(0, 0);
		state.paused = false;
		assert.equal(state.hasValidContext(), true);
		assert.equal(state.isPaused(), false);
		assert.equal(JSON.parse(state.toString()).paused, false);
	});

	test('inactive sessions never report paused', () => {
		const state = new DebugState();
		state.paused = true;
		state.updateContext(0, 0);
		assert.equal(state.isPaused(), false);
		assert.equal(state.hasValidContext(), false);
	});

	for (const paused of [null, false, true]) {
		test(`clone preserves ${paused} and reset restores unknown`, () => {
			const state = new DebugState();
			state.sessionActive = true;
			state.paused = paused;
			state.updateContext(0, 0);
			const clone = state.clone();
			assert.equal(clone.paused, paused);
			assert.equal(clone.isPaused(), state.isPaused());
			clone.reset();
			assert.equal(clone.paused, null);
			assert.equal(clone.frameId, null);
			assert.equal(clone.threadId, null);
			assert.equal(clone.isPaused(), false);
			assert.equal(state.sessionActive, true);
			assert.equal(state.paused, paused);
		});
	}
});
