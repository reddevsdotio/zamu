import { describe, expect, it } from 'vitest';
import { deleteSentence, nameError, normalizeSlugInput, slugError } from './format';

describe('slug checks', () => {
  it('turns spaces and underscores into hyphens and lowers the case while typing', () => {
    expect(normalizeSlugInput('Acme Corp_EU')).toBe('acme-corp-eu');
  });

  it('says what is wrong with a slug, reserved words included', () => {
    expect(slugError('acme')).toBeNull();
    expect(slugError('a')).toBe('Use 2 to 40 characters.');
    expect(slugError('2acme')).toBe('Start with a letter.');
    expect(slugError('acme!')).toBe('Use lowercase letters, digits and hyphens.');
    expect(slugError('acme--eu')).toBe('Use single hyphens between letters or digits, not at the end.');
    expect(slugError('acme-')).toBe('Use single hyphens between letters or digits, not at the end.');
    expect(slugError('settings')).toBe('This address is reserved. Pick another.');
  });

  it('asks for a name', () => {
    expect(nameError('  ')).toBe('Enter a workspace name.');
    expect(nameError('Acme')).toBeNull();
  });
});

describe('deleteSentence', () => {
  it('names what goes, leaving out what the workspace does not have', () => {
    expect(deleteSentence('Acme', { projects: 3, tasks: 120, agents: 2, keys: 0 })).toBe(
      'Deletes Acme with 3 projects, 120 tasks and 2 agents.',
    );
    expect(deleteSentence('Acme', { projects: 1, tasks: 1, agents: 1, keys: 1 })).toBe(
      'Deletes Acme with 1 project, 1 task, 1 agent and 1 API key.',
    );
    expect(deleteSentence('Acme', { projects: 1, tasks: 1_250, agents: 0, keys: 0 })).toBe(
      'Deletes Acme with 1 project and 1,250 tasks.',
    );
    expect(deleteSentence('Acme', { projects: 0, tasks: 0, agents: 0, keys: 0 })).toBe(
      'Deletes Acme. It has no projects yet.',
    );
  });
});
