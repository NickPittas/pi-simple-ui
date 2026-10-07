// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NativeModelControls } from './NativeModelControls.tsx';
import type { NativeModelState } from '../../shared/native-pi.ts';

afterEach(cleanup);
const m = (provider: string, id: string, name: string) => ({ provider, id, name });
const scopedList = [m('anthropic', 'sonnet', 'Claude Sonnet'), m('openai', 'gpt', 'GPT Six')];
const all = [...scopedList, m('zai', 'glm', 'GLM Flash')];
const mk = (over: Partial<NativeModelState> = {}): NativeModelState => ({ sessionId: 's', sessionGeneration: 1, processGeneration: 1, sequence: 1, model: scopedList[0]!, models: scopedList, allModels: all, scoped: true, thinkingLevel: 'medium', thinkingLevels: ['medium'], busy: false, ...over });
const setup = (state: NativeModelState | null, over: { pending?: boolean } = {}) => {
  const onModel = vi.fn();
  render(<NativeModelControls state={state} pending={over.pending ?? false} loading={false} error={null} onModel={onModel} onThinking={vi.fn()} />);
  return onModel;
};
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Model' }));
const names = () => within(screen.getByRole('listbox')).queryAllByRole('option').map((o) => o.textContent);

describe('NativeModelControls', () => {
  it('opens and lists scoped models', () => {
    setup(mk());
    open();
    expect(names()).toEqual(['Claude Sonnet', 'GPT Six']);
  });
  it('fuzzy typing filters and shows empty state', () => {
    setup(mk());
    open();
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'gpt' } });
    expect(names()).toEqual(['GPT Six']);
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'zzzz' } });
    expect(screen.getByText('No models match')).toBeTruthy();
  });
  it('ArrowDown + Enter selects', () => {
    const onModel = setup(mk());
    open();
    const input = screen.getByLabelText('Search models');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onModel).toHaveBeenCalledWith('openai', 'gpt');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('Escape closes', () => {
    setup(mk());
    open();
    fireEvent.keyDown(screen.getByLabelText('Search models'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('toggle only when scoped and switches to all models', () => {
    setup(mk());
    open();
    fireEvent.click(screen.getByText('Show all models (3)'));
    expect(names()).toHaveLength(3);
    expect(screen.getByText('Show scoped only')).toBeTruthy();
    cleanup();
    setup(mk({ scoped: false, models: all }));
    open();
    expect(screen.queryByText(/Show all models/)).toBeNull();
  });
  it('shows current unavailable model', () => {
    setup(mk({ model: m('x', 'old', 'Old One') }));
    open();
    expect(names()[0]).toBe('Old One (current)');
  });
  it('disabled does not open', () => {
    setup(mk({ busy: true }));
    open();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
