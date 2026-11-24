'use strict';

/* What the Client Portal is shown (merge safeguard S9): named allow-lists, built
   key by key like billing's invoiceView, never a spread of a row, an estimate
   snapshot or totals_json. A field the portal needs is added here by name, and
   test-portal-sessions.js holds every reply to exactly these keys.

   Nothing here carries money, the studio's notes, the client's own contact
   details beyond their names, NAS paths or internal ids other than the ones the
   portal addresses things by. */

const str = (v) => (v === null || v === undefined ? '' : String(v));

/* Who is signed in: the names the portal greets them by. */
function clientView(row) {
  return {
    businessName: str(row.business_name),
    contactName: str(row.contact_name),
  };
}

/* A project as the portal's dashboard lists it. `status` is the client's wording
   from the state model (delivery.js BADGES), never the studio's badge. */
function projectCard(project) {
  return {
    id: project.id,
    upid: str(project.upid),
    name: str(project.name),
    status: str(project.delivery.client),
    past: project.delivery.badge === 'archived',
  };
}

/* One project, with what the client has been given on its checklist: items the
   studio marked not needed, and versions not yet published, aren't theirs to see. */
function projectView(project, checklist) {
  return {
    ...projectCard(project),
    deliverables: checklist.filter((d) => !d.notNeededAt).map((d) => ({
      id: d.id,
      title: str(d.title),
      stage: d.stage,
      versions: d.versions.filter((v) => v.publishedAt).map((v) => ({
        id: v.id,
        n: v.n,
        stage: v.stage,
        kind: v.kind,
        photoCount: Number(v.photoCount) || 0,
        publishedAt: v.publishedAt,
      })),
    })),
  };
}

module.exports = { clientView, projectCard, projectView };
