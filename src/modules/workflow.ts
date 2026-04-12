/* ===================================================================
   NoteFlow — workflow.ts
   Review workflow, team assignments, status management
   =================================================================== */

import { state } from './state';
import { esc, el, elInput } from './utils';
import { getFirebaseUid } from './config';
import {
  getProjectList,
  cloudSaveProject,
} from './data';
import {
  openProject,
  toggleCardMenu,
  dashRenameProject,
  dashDeleteProject,
} from './dashboard';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkflowStatusInfo {
  label: string;
  next: string | null;
}

interface WorkflowAssignee {
  email: string;
  role: string;
}

interface WorkflowComment {
  text: string;
  by: string;
  at: string;
}

interface WorkflowHistoryEntry {
  action: string;
  by: string;
  at: string;
}

interface ProjectWorkflow {
  status: string;
  assignees: WorkflowAssignee[];
  comments: WorkflowComment[];
  history: WorkflowHistoryEntry[];
  createdBy: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WORKFLOW_STATUSES: Record<string, WorkflowStatusInfo> = {
  'draft': { label: 'Draft', next: 'in-review' },
  'in-review': { label: 'In Review', next: 'manager-approved' },
  'manager-approved': { label: 'Manager Approved', next: 'partner-approved' },
  'partner-approved': { label: 'Partner Approved', next: null },
  'returned': { label: 'Returned', next: 'in-review' },
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let currentWfProjectId: string | null = null;
let activeWfFilter: string = 'all';

// ---------------------------------------------------------------------------
// Workflow data helpers
// ---------------------------------------------------------------------------

export function getProjectWorkflow(projectId: string): ProjectWorkflow {
  try {
    const wf = JSON.parse(localStorage.getItem('noteflow-wf-' + projectId)!);
    return wf || {
      status: 'draft',
      assignees: [],
      comments: [],
      history: [],
      createdBy: state.currentUserEmail,
    };
  } catch (e) {
    return {
      status: 'draft',
      assignees: [],
      comments: [],
      history: [],
      createdBy: state.currentUserEmail!,
    };
  }
}

export function saveProjectWorkflow(projectId: string, wf: ProjectWorkflow): void {
  localStorage.setItem('noteflow-wf-' + projectId, JSON.stringify(wf));
  if (getFirebaseUid()) {
    cloudSaveProject(projectId, { workflow: wf } as any);
  }
}

export function getWorkflowBadgeHTML(status: string): string {
  const info: WorkflowStatusInfo =
    WORKFLOW_STATUSES[status] || WORKFLOW_STATUSES['draft'];
  return (
    '<span class="wf-badge ' +
    (status || 'draft') +
    '"><span class="wf-badge-dot"></span>' +
    info.label +
    '</span>'
  );
}

// ---------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------

export function renderDashStats(): void {
  const list = getProjectList(state.currentUserEmail!);
  const total: number = list.length;
  const counts: Record<string, number> = {
    draft: 0,
    'in-review': 0,
    'manager-approved': 0,
    'partner-approved': 0,
    returned: 0,
  };
  list.forEach(function (p) {
    const wf = getProjectWorkflow(p.id);
    const s: string = wf.status || 'draft';
    if (counts[s] !== undefined) counts[s]++;
  });
  const stats = el('dash-stats');
  if (stats) {
    stats.innerHTML =
      '<div class="dash-stat-card"><div class="stat-value">' +
      total +
      '</div><div class="stat-label">Total Projects</div></div>' +
      '<div class="dash-stat-card"><div class="stat-value" style="color:#64748b">' +
      counts.draft +
      '</div><div class="stat-label">Drafts</div></div>' +
      '<div class="dash-stat-card"><div class="stat-value" style="color:#f59e0b">' +
      counts['in-review'] +
      '</div><div class="stat-label">In Review</div></div>' +
      '<div class="dash-stat-card"><div class="stat-value" style="color:#3b82f6">' +
      counts['manager-approved'] +
      '</div><div class="stat-label">Mgr Approved</div></div>' +
      '<div class="dash-stat-card"><div class="stat-value" style="color:#22c55e">' +
      counts['partner-approved'] +
      '</div><div class="stat-label">Completed</div></div>' +
      (counts.returned > 0
        ? '<div class="dash-stat-card"><div class="stat-value" style="color:#ef4444">' +
          counts.returned +
          '</div><div class="stat-label">Returned</div></div>'
        : '');
  }
}

// ---------------------------------------------------------------------------
// Workflow filter bar
// ---------------------------------------------------------------------------

function renderWfFilterBar(): void {
  const list = getProjectList(state.currentUserEmail!);
  const counts: Record<string, number> = {
    all: list.length,
    draft: 0,
    'in-review': 0,
    'manager-approved': 0,
    'partner-approved': 0,
    returned: 0,
  };
  list.forEach(function (p) {
    const wf = getProjectWorkflow(p.id);
    const s: string = wf.status || 'draft';
    if (counts[s] !== undefined) counts[s]++;
  });
  const bar = el('wf-filter-bar');
  if (!bar) return;
  const filters = [
    { key: 'all', label: 'All' },
    { key: 'draft', label: 'Drafts' },
    { key: 'in-review', label: 'In Review' },
    { key: 'manager-approved', label: 'Mgr Approved' },
    { key: 'partner-approved', label: 'Completed' },
    { key: 'returned', label: 'Returned' },
  ];
  let html = '';
  filters.forEach(function (f) {
    if (f.key !== 'all' && f.key !== 'returned' && counts[f.key] === 0 && f.key !== activeWfFilter)
      return;
    if (f.key === 'returned' && counts.returned === 0) return;
    html +=
      '<button class="wf-filter-btn' +
      (activeWfFilter === f.key ? ' active' : '') +
      '" data-wf-action="setFilter" data-filter="' +
      f.key +
      '">' +
      f.label +
      '<span class="wf-count">' +
      (counts[f.key] || 0) +
      '</span></button>';
  });
  bar.innerHTML = html;
}

export function setWfFilter(filter: string): void {
  activeWfFilter = filter;
  renderWfFilterBar();
  renderProjectGrid();
}

export function filterProjectGrid(): void {
  renderProjectGrid();
}

// ---------------------------------------------------------------------------
// Revamped project grid (workflow-aware override)
// ---------------------------------------------------------------------------

export function renderProjectGrid(): void {
  let list = getProjectList(state.currentUserEmail!);
  list.sort(function (a, b) {
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
  const grid = el('project-grid');
  if (!grid) return;
  const searchTerm: string = (elInput('dash-search')?.value ?? '')
    .toLowerCase()
    .trim();

  // Filter by workflow status
  if (activeWfFilter !== 'all') {
    list = list.filter(function (p) {
      const wf = getProjectWorkflow(p.id);
      return (wf.status || 'draft') === activeWfFilter;
    });
  }

  // Filter by search
  if (searchTerm) {
    list = list.filter(function (p) {
      return (p.name || '').toLowerCase().indexOf(searchTerm) >= 0;
    });
  }

  if (list.length === 0) {
    grid.innerHTML =
      '<div class="empty-state"><p>' +
      (searchTerm
        ? 'No projects match your search.'
        : 'No projects yet. Create your first project to get started.') +
      '</p></div>';
    return;
  }

  let html = '';
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const wf = getProjectWorkflow(p.id);
    const status: string = wf.status || 'draft';
    const dateStr: string = p.updatedAt
      ? new Date(p.updatedAt).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : '';
    const commentCount: number = (wf.comments || []).length;
    const assigneeStr: string = (wf.assignees || [])
      .map(function (a) {
        return a.email.split('@')[0];
      })
      .join(', ');

    html += '<div class="project-card" data-wf-action="open" data-id="' + esc(p.id) + '">';

    // Top row: name + menu
    html += '<div class="pc-top"><div>';
    html += '<div class="pc-name">' + esc(p.name) + '</div>';
    if (wf.createdBy && wf.createdBy !== state.currentUserEmail) {
      html += '<div class="pc-client">by ' + esc(wf.createdBy.split('@')[0]) + '</div>';
    }
    html += '</div>';
    html += '<div class="pc-menu-wrap">';
    html +=
      '<button class="pc-dots" data-wf-action="toggleMenu" aria-label="Menu">&#8943;</button>';
    html += '<div class="pc-dropdown">';
    html +=
      '<button data-wf-action="workflow" data-id="' +
      esc(p.id) +
      '">Workflow</button>';
    html +=
      '<button data-wf-action="rename" data-id="' + esc(p.id) +
      '" data-name="' + esc(p.name) +
      '">Rename</button>';
    html +=
      '<button class="danger" data-wf-action="delete" data-id="' + esc(p.id) +
      '" data-name="' + esc(p.name) +
      '">Delete</button>';
    html += '</div></div></div>';

    // Meta row
    html += '<div class="pc-meta">';
    html += '<span>Updated: ' + esc(dateStr) + '</span>';
    if (commentCount > 0)
      html +=
        '<span class="pc-comment-count">' +
        commentCount +
        ' comment' +
        (commentCount > 1 ? 's' : '') +
        '</span>';
    html += '</div>';

    // Footer: badge + assignee
    html += '<div class="pc-footer">';
    html += getWorkflowBadgeHTML(status);
    if (assigneeStr) {
      html += '<span class="pc-assignee">Assigned: ' + esc(assigneeStr) + '</span>';
    }
    html += '</div>';

    html += '</div>';
  }
  grid.innerHTML = html;

  renderDashStats();
  renderWfFilterBar();
}

// ---------------------------------------------------------------------------
// Workflow Modal
// ---------------------------------------------------------------------------

export function openWorkflowModal(projectId: string): void {
  currentWfProjectId = projectId;
  document.querySelectorAll('.pc-dropdown.open').forEach(function (el) {
    el.classList.remove('open');
  });
  const list = getProjectList(state.currentUserEmail!);
  const entry = list.find(function (p) {
    return p.id === projectId;
  });
  const wf = getProjectWorkflow(projectId);

  const wfName = el('wf-modal-project-name');
  if (wfName) wfName.textContent = entry ? entry.name : 'Project';
  const wfStatus = el('wf-current-status');
  if (wfStatus) wfStatus.innerHTML = getWorkflowBadgeHTML(wf.status || 'draft');

  // Assignees
  renderWfAssignees(wf);

  // Actions based on status
  renderWfActions(wf);

  // Timeline
  renderWfTimeline(wf);

  // Comments
  renderWfComments(wf);

  el('workflow-modal')?.classList.add('open');
}

export function closeWorkflowModal(): void {
  el('workflow-modal')?.classList.remove('open');
  currentWfProjectId = null;
}

function renderWfAssignees(wf: ProjectWorkflow): void {
  let html = '';
  (wf.assignees || []).forEach(function (a, i) {
    html +=
      '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:0.82rem">';
    html += '<span style="color:var(--text)">' + esc(a.email) + '</span>';
    html +=
      '<span class="wf-badge ' +
      (a.role === 'partner' ? 'partner-approved' : 'manager-approved') +
      '" style="font-size:0.65rem">' +
      (a.role === 'partner' ? 'Partner' : 'Manager') +
      '</span>';
    html +=
      '<button class="btn btn-ghost btn-sm" style="font-size:0.7rem;padding:2px 8px;color:var(--red)" data-wf-action="removeAssignee" data-idx="' +
      i +
      '">Remove</button>';
    html += '</div>';
  });
  if (!wf.assignees || wf.assignees.length === 0) {
    html =
      '<div style="font-size:0.82rem;color:var(--muted);padding:4px 0">No reviewers assigned yet.</div>';
  }
  const wfAssignees = el('wf-assignees');
  if (wfAssignees) wfAssignees.innerHTML = html;
}

export function assignReviewer(): void {
  const email: string = (elInput('wf-assign-email')?.value ?? '')
    .trim()
    .toLowerCase();
  const role: string = elInput('wf-assign-role')?.value ?? '';
  if (!email || !email.includes('@')) {
    alert('Enter a valid email.');
    return;
  }
  const wf = getProjectWorkflow(currentWfProjectId!);
  if (!wf.assignees) wf.assignees = [];
  if (
    wf.assignees.some(function (a) {
      return a.email === email;
    })
  ) {
    alert('Already assigned.');
    return;
  }
  wf.assignees.push({ email: email, role: role });
  addWfHistory(wf, 'Assigned ' + email + ' as ' + role);
  saveProjectWorkflow(currentWfProjectId!, wf);
  const assignInput = elInput('wf-assign-email');
  if (assignInput) assignInput.value = '';
  renderWfAssignees(wf);
  renderWfTimeline(wf);
  renderProjectGrid();
  // Send email alert
  sendWorkflowEmail(email, 'assigned', currentWfProjectId!);
}

export function removeAssignee(idx: number): void {
  const wf = getProjectWorkflow(currentWfProjectId!);
  const removed = wf.assignees.splice(idx, 1);
  if (removed.length) addWfHistory(wf, 'Removed ' + removed[0].email);
  saveProjectWorkflow(currentWfProjectId!, wf);
  renderWfAssignees(wf);
  renderWfTimeline(wf);
  renderProjectGrid();
}

function renderWfActions(wf: ProjectWorkflow): void {
  const status: string = wf.status || 'draft';
  let html = '';
  if (status === 'draft') {
    html +=
      '<button class="btn btn-primary btn-sm" data-wf-action="advance" data-status="in-review">Submit for Review</button>';
  } else if (status === 'in-review') {
    html +=
      '<button class="btn btn-primary btn-sm" data-wf-action="advance" data-status="manager-approved">Approve (Manager)</button>';
    html +=
      '<button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:var(--red)" data-wf-action="advance" data-status="returned">Return for Revision</button>';
  } else if (status === 'manager-approved') {
    html +=
      '<button class="btn btn-primary btn-sm" style="background:linear-gradient(135deg,#22c55e,#16a34a)" data-wf-action="advance" data-status="partner-approved">Final Approval (Partner)</button>';
    html +=
      '<button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:var(--red)" data-wf-action="advance" data-status="returned">Return for Revision</button>';
  } else if (status === 'partner-approved') {
    html +=
      '<span style="font-size:0.85rem;color:var(--green);font-weight:600">Approved &amp; Complete</span>';
  } else if (status === 'returned') {
    html +=
      '<button class="btn btn-primary btn-sm" data-wf-action="advance" data-status="in-review">Resubmit for Review</button>';
  }
  const wfActions = el('wf-actions');
  if (wfActions) wfActions.innerHTML = html;
}

export function advanceWorkflow(newStatus: string): void {
  const wf = getProjectWorkflow(currentWfProjectId!);
  const oldStatus: string = wf.status || 'draft';
  wf.status = newStatus;
  let actionLabel = '';
  if (newStatus === 'in-review')
    actionLabel = oldStatus === 'returned' ? 'Resubmitted for review' : 'Submitted for review';
  else if (newStatus === 'manager-approved') actionLabel = 'Manager approved';
  else if (newStatus === 'partner-approved') actionLabel = 'Partner approved (final)';
  else if (newStatus === 'returned') actionLabel = 'Returned for revision';
  addWfHistory(wf, actionLabel);
  saveProjectWorkflow(currentWfProjectId!, wf);

  // Notify assignees
  (wf.assignees || []).forEach(function (a) {
    sendWorkflowEmail(a.email, newStatus, currentWfProjectId!);
  });
  // Also notify the creator if not the current user
  if (wf.createdBy && wf.createdBy !== state.currentUserEmail) {
    sendWorkflowEmail(wf.createdBy, newStatus, currentWfProjectId!);
  }

  openWorkflowModal(currentWfProjectId!);
  renderProjectGrid();
}

export function addWfHistory(wf: ProjectWorkflow, action: string): void {
  if (!wf.history) wf.history = [];
  wf.history.push({
    action: action,
    by: state.currentUserEmail!,
    at: new Date().toISOString(),
  });
}

function renderWfTimeline(wf: ProjectWorkflow): void {
  const timeline = el('wf-timeline');
  if (!timeline) return;
  const history = (wf.history || []).slice().reverse();
  if (history.length === 0) {
    timeline.innerHTML =
      '<div class="wf-timeline-item"><span class="wf-tl-action">Project created</span></div>';
    return;
  }
  let html = '';
  history.forEach(function (h, i) {
    const timeStr: string = h.at
      ? new Date(h.at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : '';
    html += '<div class="wf-timeline-item' + (i === 0 ? ' active' : '') + '">';
    html += '<span class="wf-tl-action">' + esc(h.action) + '</span>';
    html +=
      '<span style="color:var(--muted);font-size:0.75rem"> by ' +
      esc((h.by || '').split('@')[0]) +
      '</span>';
    html += '<div class="wf-tl-time">' + esc(timeStr) + '</div>';
    html += '</div>';
  });
  timeline.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function renderWfComments(wf: ProjectWorkflow): void {
  const container = el('wf-comments');
  if (!container) return;
  const comments = wf.comments || [];
  if (comments.length === 0) {
    container.innerHTML =
      '<div style="font-size:0.82rem;color:var(--muted);padding:8px 0">No comments yet.</div>';
    return;
  }
  let html = '';
  comments.forEach(function (c) {
    const timeStr: string = c.at
      ? new Date(c.at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : '';
    html += '<div class="comment-item">';
    html +=
      '<div class="comment-header"><span class="comment-author">' +
      esc((c.by || '').split('@')[0]) +
      '</span><span class="comment-time">' +
      esc(timeStr) +
      '</span></div>';
    html += '<div class="comment-body">' + esc(c.text) + '</div>';
    html += '</div>';
  });
  container.innerHTML = html;
}

export function addComment(): void {
  const input = elInput('wf-comment-input');
  if (!input) return;
  const text: string = (input.value || '').trim();
  if (!text) return;
  const wf = getProjectWorkflow(currentWfProjectId!);
  if (!wf.comments) wf.comments = [];
  wf.comments.push({
    text: text,
    by: state.currentUserEmail!,
    at: new Date().toISOString(),
  });
  addWfHistory(wf, 'Added a comment');
  saveProjectWorkflow(currentWfProjectId!, wf);
  input.value = '';
  renderWfComments(wf);
  renderWfTimeline(wf);
  renderProjectGrid();

  // Notify assignees about the comment
  (wf.assignees || []).forEach(function (a) {
    if (a.email !== state.currentUserEmail)
      sendWorkflowEmail(a.email, 'comment', currentWfProjectId!);
  });
}

// ---------------------------------------------------------------------------
// Email Alerts (via Firestore queue for Cloud Functions)
// ---------------------------------------------------------------------------

/**
 * Queues a workflow notification email via Firestore for delivery by Cloud Functions.
 */
function sendWorkflowEmail(
  toEmail: string,
  eventType: string,
  projectId: string
): void {
  if (!getFirebaseUid()) return;
  const list = getProjectList(state.currentUserEmail!);
  const entry = list.find(function (p) {
    return p.id === projectId;
  });
  const projectName: string = entry ? entry.name : 'a project';

  const subjects: Record<string, string> = {
    assigned: 'You have been assigned to review: ' + projectName,
    'in-review': projectName + ' has been submitted for review',
    'manager-approved': projectName + ' has been approved by manager',
    'partner-approved': projectName + ' has received final approval',
    returned: projectName + ' has been returned for revision',
    comment: 'New comment on ' + projectName,
  };

  const emailDoc: Record<string, any> = {
    to: toEmail,
    from: state.currentUserEmail,
    subject: subjects[eventType] || 'NoteFlow workflow update',
    projectId: projectId,
    projectName: projectName,
    eventType: eventType,
    createdAt: new Date().toISOString(),
    sent: false,
  };

  try {
    state.firebaseDb.collection('emailQueue').add(emailDoc).catch(function(err: any) { console.warn('[NoteFlow] Failed to queue workflow email:', err.message); });
  } catch (e) {
    console.warn('Email queue failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Event Delegation — workflow project grid, filter bar, modal actions
// ---------------------------------------------------------------------------

document.addEventListener('click', function (e: MouseEvent) {
  const target = (e.target as HTMLElement).closest('[data-wf-action]') as HTMLElement | null;
  if (!target) return;

  const action = target.dataset.wfAction;
  const id = target.dataset.id;
  const name = target.dataset.name;

  switch (action) {
    // Project grid card actions
    case 'open':
      if (id) openProject(id);
      break;
    case 'toggleMenu':
      e.stopPropagation();
      toggleCardMenu(target);
      break;
    case 'workflow':
      e.stopPropagation();
      if (id) openWorkflowModal(id);
      break;
    case 'rename':
      e.stopPropagation();
      if (id && name !== undefined) dashRenameProject(id, name);
      break;
    case 'delete':
      e.stopPropagation();
      if (id && name !== undefined) dashDeleteProject(id, name);
      break;
    // Filter bar
    case 'setFilter':
      setWfFilter(target.dataset.filter || 'all');
      break;
    // Assignee removal
    case 'removeAssignee': {
      const idx = parseInt(target.dataset.idx || '0', 10);
      removeAssignee(idx);
      break;
    }
    // Advance workflow status
    case 'advance': {
      const newStatus = target.dataset.status;
      if (newStatus) advanceWorkflow(newStatus);
      break;
    }
  }
});
