/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — workflow.test.ts
   Unit tests for workflow management, badges, filters, and comments.
   ═══════════════════════════════════════════════════════════════════════ */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { state } from '../src/modules/state';

// Mock config module
vi.mock('../src/modules/config', () => ({
  FIREBASE_ENABLED: false,
  ENCRYPTION_ENABLED: false,
  trackEvent: vi.fn(),
  getFirebaseUid: vi.fn(() => null),
}));

// Mock data module — use real localStorage for project lists
vi.mock('../src/modules/data', () => ({
  getProjectList: (email: string) => {
    try {
      return JSON.parse(localStorage.getItem('fsgen-projects-' + email) || '[]');
    } catch { return []; }
  },
  saveProjectList: (email: string, list: any[]) => {
    localStorage.setItem('fsgen-projects-' + email, JSON.stringify(list));
  },
  cloudSaveProject: vi.fn(() => Promise.resolve()),
  cloudSaveUserData: vi.fn(() => Promise.resolve()),
}));

import {
  WORKFLOW_STATUSES,
  getProjectWorkflow,
  saveProjectWorkflow,
  getWorkflowBadgeHTML,
  addWfHistory,
  renderProjectGrid,
  addComment,
  advanceWorkflow,
  openWorkflowModal,
  closeWorkflowModal,
} from '../src/modules/workflow';

// ─── DOM Setup ────────────────────────────────────────────────────────────────

function setupWorkflowDOM(): void {
  document.body.innerHTML = `
    <div id="project-grid"></div>
    <div id="dash-stats"></div>
    <input id="dash-search" value="" />
    <div id="wf-filter-bar"></div>
    <div id="workflow-modal" class=""></div>
    <div id="wf-modal-project-name"></div>
    <div id="wf-current-status"></div>
    <div id="wf-assignees"></div>
    <div id="wf-actions"></div>
    <div id="wf-timeline"></div>
    <div id="wf-comments"></div>
    <input id="wf-comment-input" value="" />
    <input id="wf-assign-email" value="" />
    <select id="wf-assign-role"><option value="manager">Manager</option></select>
  `;
}

function seedProjects(email: string, projects: any[]): void {
  localStorage.setItem('fsgen-projects-' + email, JSON.stringify(projects));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WORKFLOW_STATUSES', () => {
  it('has draft status', () => {
    expect(WORKFLOW_STATUSES['draft']).toBeDefined();
    expect(WORKFLOW_STATUSES['draft'].label).toBe('Draft');
  });

  it('has in-review status', () => {
    expect(WORKFLOW_STATUSES['in-review']).toBeDefined();
    expect(WORKFLOW_STATUSES['in-review'].label).toBe('In Review');
  });

  it('has manager-approved status', () => {
    expect(WORKFLOW_STATUSES['manager-approved']).toBeDefined();
    expect(WORKFLOW_STATUSES['manager-approved'].label).toBe('Manager Approved');
  });

  it('has partner-approved status as final (next is null)', () => {
    expect(WORKFLOW_STATUSES['partner-approved']).toBeDefined();
    expect(WORKFLOW_STATUSES['partner-approved'].next).toBeNull();
  });

  it('has returned status', () => {
    expect(WORKFLOW_STATUSES['returned']).toBeDefined();
    expect(WORKFLOW_STATUSES['returned'].label).toBe('Returned');
  });

  it('draft flows to in-review', () => {
    expect(WORKFLOW_STATUSES['draft'].next).toBe('in-review');
  });

  it('in-review flows to manager-approved', () => {
    expect(WORKFLOW_STATUSES['in-review'].next).toBe('manager-approved');
  });

  it('manager-approved flows to partner-approved', () => {
    expect(WORKFLOW_STATUSES['manager-approved'].next).toBe('partner-approved');
  });

  it('returned flows back to in-review', () => {
    expect(WORKFLOW_STATUSES['returned'].next).toBe('in-review');
  });
});

describe('getProjectWorkflow() / saveProjectWorkflow()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
  });

  it('returns default workflow when nothing stored', () => {
    const wf = getProjectWorkflow('proj-1');
    expect(wf.status).toBe('draft');
    expect(wf.assignees).toEqual([]);
    expect(wf.comments).toEqual([]);
    expect(wf.history).toEqual([]);
  });

  it('round-trips workflow data', () => {
    const wfData = {
      status: 'in-review',
      assignees: [{ email: 'reviewer@test.com', role: 'manager' }],
      comments: [{ text: 'Looks good', by: 'test@example.com', at: '2025-01-01T00:00:00Z' }],
      history: [{ action: 'Submitted', by: 'test@example.com', at: '2025-01-01T00:00:00Z' }],
      createdBy: 'test@example.com',
    };
    saveProjectWorkflow('proj-1', wfData);
    const loaded = getProjectWorkflow('proj-1');
    expect(loaded.status).toBe('in-review');
    expect(loaded.assignees).toHaveLength(1);
    expect(loaded.comments).toHaveLength(1);
    expect(loaded.history).toHaveLength(1);
  });

  it('stores per-project (isolation)', () => {
    saveProjectWorkflow('proj-a', {
      status: 'draft', assignees: [], comments: [], history: [], createdBy: 'a@test.com',
    });
    saveProjectWorkflow('proj-b', {
      status: 'partner-approved', assignees: [], comments: [], history: [], createdBy: 'b@test.com',
    });
    expect(getProjectWorkflow('proj-a').status).toBe('draft');
    expect(getProjectWorkflow('proj-b').status).toBe('partner-approved');
  });

  it('handles corrupted localStorage', () => {
    localStorage.setItem('noteflow-wf-bad', 'not-json!!!');
    const wf = getProjectWorkflow('bad');
    expect(wf.status).toBe('draft');
  });

  it('stores under the correct localStorage key', () => {
    saveProjectWorkflow('test-key', {
      status: 'draft', assignees: [], comments: [], history: [], createdBy: 'x@test.com',
    });
    const raw = localStorage.getItem('noteflow-wf-test-key');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).status).toBe('draft');
  });
});

describe('getWorkflowBadgeHTML()', () => {
  it('returns HTML with the status class', () => {
    const html = getWorkflowBadgeHTML('draft');
    expect(html).toContain('wf-badge');
    expect(html).toContain('draft');
  });

  it('includes the label text for draft', () => {
    const html = getWorkflowBadgeHTML('draft');
    expect(html).toContain('Draft');
  });

  it('includes the label text for in-review', () => {
    const html = getWorkflowBadgeHTML('in-review');
    expect(html).toContain('In Review');
  });

  it('includes the label for partner-approved', () => {
    const html = getWorkflowBadgeHTML('partner-approved');
    expect(html).toContain('Partner Approved');
  });

  it('includes the label for returned', () => {
    const html = getWorkflowBadgeHTML('returned');
    expect(html).toContain('Returned');
  });

  it('falls back to draft for unknown statuses', () => {
    const html = getWorkflowBadgeHTML('unknown-status');
    expect(html).toContain('Draft');
  });

  it('includes a badge dot element', () => {
    const html = getWorkflowBadgeHTML('draft');
    expect(html).toContain('wf-badge-dot');
  });
});

describe('addWfHistory()', () => {
  beforeEach(() => {
    state.currentUserEmail = 'actor@test.com';
  });

  it('adds a history entry', () => {
    const wf = { status: 'draft', assignees: [], comments: [], history: [] as any[], createdBy: 'x@test.com' };
    addWfHistory(wf, 'Submitted for review');
    expect(wf.history).toHaveLength(1);
    expect(wf.history[0].action).toBe('Submitted for review');
    expect(wf.history[0].by).toBe('actor@test.com');
    expect(wf.history[0].at).toBeDefined();
  });

  it('appends to existing history', () => {
    const wf = {
      status: 'draft', assignees: [], comments: [],
      history: [{ action: 'Created', by: 'x@test.com', at: '2025-01-01T00:00:00Z' }],
      createdBy: 'x@test.com',
    };
    addWfHistory(wf, 'Updated');
    expect(wf.history).toHaveLength(2);
    expect(wf.history[1].action).toBe('Updated');
  });

  it('initializes history array if undefined', () => {
    const wf = { status: 'draft', assignees: [], comments: [], createdBy: 'x@test.com' } as any;
    delete wf.history;
    addWfHistory(wf, 'First action');
    expect(wf.history).toHaveLength(1);
  });
});

describe('renderProjectGrid() (workflow-aware)', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    state.currentUserName = 'Test User';
    setupWorkflowDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows empty state when no projects', () => {
    renderProjectGrid();
    const grid = document.getElementById('project-grid')!;
    expect(grid.innerHTML).toContain('empty-state');
  });

  it('renders project cards with workflow badges', () => {
    seedProjects('test@example.com', [
      { id: 'p1', name: 'Alpha', updatedAt: '2025-01-01T00:00:00Z' },
    ]);
    saveProjectWorkflow('p1', {
      status: 'in-review', assignees: [], comments: [], history: [], createdBy: 'test@example.com',
    });
    renderProjectGrid();
    const grid = document.getElementById('project-grid')!;
    expect(grid.innerHTML).toContain('Alpha');
    expect(grid.innerHTML).toContain('wf-badge');
    expect(grid.innerHTML).toContain('In Review');
  });

  it('renders comment count when comments exist', () => {
    seedProjects('test@example.com', [
      { id: 'p1', name: 'Commented', updatedAt: '2025-01-01T00:00:00Z' },
    ]);
    saveProjectWorkflow('p1', {
      status: 'draft',
      assignees: [],
      comments: [
        { text: 'First', by: 'a@test.com', at: '2025-01-01T00:00:00Z' },
        { text: 'Second', by: 'b@test.com', at: '2025-01-02T00:00:00Z' },
      ],
      history: [],
      createdBy: 'test@example.com',
    });
    renderProjectGrid();
    const grid = document.getElementById('project-grid')!;
    expect(grid.innerHTML).toContain('2 comments');
  });

  it('renders assignees on project cards', () => {
    seedProjects('test@example.com', [
      { id: 'p1', name: 'Assigned', updatedAt: '2025-01-01T00:00:00Z' },
    ]);
    saveProjectWorkflow('p1', {
      status: 'in-review',
      assignees: [{ email: 'reviewer@firm.com', role: 'manager' }],
      comments: [],
      history: [],
      createdBy: 'test@example.com',
    });
    renderProjectGrid();
    const grid = document.getElementById('project-grid')!;
    expect(grid.innerHTML).toContain('reviewer');
  });
});

describe('addComment()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'commenter@test.com';
    setupWorkflowDOM();
    seedProjects('commenter@test.com', [
      { id: 'comment-proj', name: 'Comment Test', updatedAt: '2025-01-01T00:00:00Z' },
    ]);
    saveProjectWorkflow('comment-proj', {
      status: 'in-review', assignees: [], comments: [], history: [], createdBy: 'commenter@test.com',
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does nothing when input is empty', () => {
    // Access private module state by opening the workflow modal first
    openWorkflowModal('comment-proj');
    (document.getElementById('wf-comment-input') as HTMLInputElement).value = '';
    addComment();
    const wf = getProjectWorkflow('comment-proj');
    expect(wf.comments).toHaveLength(0);
  });

  it('does nothing for whitespace-only input', () => {
    openWorkflowModal('comment-proj');
    (document.getElementById('wf-comment-input') as HTMLInputElement).value = '   ';
    addComment();
    const wf = getProjectWorkflow('comment-proj');
    expect(wf.comments).toHaveLength(0);
  });

  it('adds a comment with text and author', () => {
    openWorkflowModal('comment-proj');
    (document.getElementById('wf-comment-input') as HTMLInputElement).value = 'Great work!';
    addComment();
    const wf = getProjectWorkflow('comment-proj');
    expect(wf.comments).toHaveLength(1);
    expect(wf.comments[0].text).toBe('Great work!');
    expect(wf.comments[0].by).toBe('commenter@test.com');
  });

  it('clears the input after adding', () => {
    openWorkflowModal('comment-proj');
    (document.getElementById('wf-comment-input') as HTMLInputElement).value = 'Test comment';
    addComment();
    expect((document.getElementById('wf-comment-input') as HTMLInputElement).value).toBe('');
  });

  it('adds history entry for the comment', () => {
    openWorkflowModal('comment-proj');
    (document.getElementById('wf-comment-input') as HTMLInputElement).value = 'Review note';
    addComment();
    const wf = getProjectWorkflow('comment-proj');
    const commentHistory = wf.history.find((h: any) => h.action === 'Added a comment');
    expect(commentHistory).toBeDefined();
  });
});

describe('advanceWorkflow()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'manager@test.com';
    setupWorkflowDOM();
    seedProjects('manager@test.com', [
      { id: 'adv-proj', name: 'Advance Test', updatedAt: '2025-01-01T00:00:00Z' },
    ]);
    saveProjectWorkflow('adv-proj', {
      status: 'draft', assignees: [], comments: [], history: [], createdBy: 'manager@test.com',
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('transitions from draft to in-review', () => {
    openWorkflowModal('adv-proj');
    advanceWorkflow('in-review');
    const wf = getProjectWorkflow('adv-proj');
    expect(wf.status).toBe('in-review');
  });

  it('transitions from in-review to manager-approved', () => {
    saveProjectWorkflow('adv-proj', {
      status: 'in-review', assignees: [], comments: [], history: [], createdBy: 'manager@test.com',
    });
    openWorkflowModal('adv-proj');
    advanceWorkflow('manager-approved');
    const wf = getProjectWorkflow('adv-proj');
    expect(wf.status).toBe('manager-approved');
  });

  it('transitions from manager-approved to partner-approved', () => {
    saveProjectWorkflow('adv-proj', {
      status: 'manager-approved', assignees: [], comments: [], history: [], createdBy: 'manager@test.com',
    });
    openWorkflowModal('adv-proj');
    advanceWorkflow('partner-approved');
    const wf = getProjectWorkflow('adv-proj');
    expect(wf.status).toBe('partner-approved');
  });

  it('can return a project for revision', () => {
    saveProjectWorkflow('adv-proj', {
      status: 'in-review', assignees: [], comments: [], history: [], createdBy: 'manager@test.com',
    });
    openWorkflowModal('adv-proj');
    advanceWorkflow('returned');
    const wf = getProjectWorkflow('adv-proj');
    expect(wf.status).toBe('returned');
  });

  it('adds history entry on status change', () => {
    openWorkflowModal('adv-proj');
    advanceWorkflow('in-review');
    const wf = getProjectWorkflow('adv-proj');
    expect(wf.history.length).toBeGreaterThan(0);
    const lastEntry = wf.history[wf.history.length - 1];
    expect(lastEntry.action).toContain('review');
    expect(lastEntry.by).toBe('manager@test.com');
  });

  it('records correct action label for submission', () => {
    openWorkflowModal('adv-proj');
    advanceWorkflow('in-review');
    const wf = getProjectWorkflow('adv-proj');
    const entry = wf.history.find((h: any) => h.action.includes('Submitted'));
    expect(entry).toBeDefined();
  });

  it('records correct action label for resubmission from returned', () => {
    saveProjectWorkflow('adv-proj', {
      status: 'returned', assignees: [], comments: [], history: [], createdBy: 'manager@test.com',
    });
    openWorkflowModal('adv-proj');
    advanceWorkflow('in-review');
    const wf = getProjectWorkflow('adv-proj');
    const entry = wf.history.find((h: any) => h.action.includes('Resubmitted'));
    expect(entry).toBeDefined();
  });
});

describe('openWorkflowModal() / closeWorkflowModal()', () => {
  beforeEach(() => {
    localStorage.clear();
    state.currentUserEmail = 'test@example.com';
    setupWorkflowDOM();
    seedProjects('test@example.com', [
      { id: 'modal-proj', name: 'Modal Test', updatedAt: '2025-01-01T00:00:00Z' },
    ]);
    saveProjectWorkflow('modal-proj', {
      status: 'in-review', assignees: [], comments: [], history: [], createdBy: 'test@example.com',
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens the workflow modal', () => {
    openWorkflowModal('modal-proj');
    expect(document.getElementById('workflow-modal')!.classList.contains('open')).toBe(true);
  });

  it('sets the project name in the modal', () => {
    openWorkflowModal('modal-proj');
    expect(document.getElementById('wf-modal-project-name')!.textContent).toBe('Modal Test');
  });

  it('displays the current workflow status badge', () => {
    openWorkflowModal('modal-proj');
    expect(document.getElementById('wf-current-status')!.innerHTML).toContain('In Review');
  });

  it('closes the workflow modal', () => {
    document.getElementById('workflow-modal')!.classList.add('open');
    closeWorkflowModal();
    expect(document.getElementById('workflow-modal')!.classList.contains('open')).toBe(false);
  });
});
