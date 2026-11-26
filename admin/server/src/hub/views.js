'use strict';

/* What the Client Portal is shown (merge safeguard S9): named allow-lists, built
   key by key like billing's invoiceView, never a spread of a row, an estimate
   snapshot or totals_json. A field the portal needs is added here by name, and
   test-portal-sessions.js holds every reply to exactly these keys.

   Nothing here carries money (beyond what the client was sent: an invoice's amount, C3,
   and the hourly rate their own signed agreement states, C5), the studio's notes, the client's own contact
   details beyond their names, NAS paths or internal ids other than the ones the
   portal addresses things by. */

const str = (v) => (v === null || v === undefined ? '' : String(v));
// Loaded here, not with the module: delivery.js reads billing's code as it loads.
const delivery = () => require('../delivery');

/* Who is signed in: the names the portal greets them by. */
function clientView(row) {
  return {
    businessName: str(row.business_name),
    contactName: str(row.contact_name),
  };
}

/* What the client does next, by the state model's badge (IA "Project State
   Model"): the line under the status on the dashboard and the project page. */
const NEXT_STEP = {
  revisions: 'Nothing to do for now. We’ll let you know when the new version is ready.',
  in_review: 'Review what’s ready below, then add your notes or approve.',
  in_production: 'Nothing to do for now. We’ll email you when there’s something to review.',
  send_invoice: 'Nothing to do for now. Your invoice will arrive by email.',
  payment_claimed: 'Nothing to do. We’ll confirm your payment shortly.',
  payment_due: 'Pay your invoice to receive your files.',
  downloads_locked: 'Get in touch with the studio to carry on.',
  complete: 'All done. Thanks for working with us.',
  archived: 'All done. Thanks for working with us.',
};
/* The badges that wait on the client: the dashboard lists these first. */
const NEEDS_CLIENT = new Set(['in_review', 'payment_due']);

/* A project as the portal's dashboard lists it. `status` is the client's wording
   from the state model (delivery.js BADGES), never the studio's badge. */
function projectCard(project) {
  const { badge } = project.delivery;
  return {
    id: project.id,
    upid: str(project.upid),
    name: str(project.name),
    status: str(project.delivery.client),
    nextStep: NEXT_STEP[badge] || '',
    needsYou: NEEDS_CLIENT.has(badge),
    past: badge === 'archived',
  };
}

/* Where one checklist item stands for the client, in the state model's order
   (delivery.js stateOf): signed off, notes with the studio, ready for them, or
   with the studio (nothing published yet, or a draft they approved, which the
   Final follows). */
function itemStatus(d) {
  if (delivery().itemApproved(d)) return 'approved';
  const newest = delivery().newestPublished(d);
  if (d.hubStatus === 'changes' || (newest && newest.submittedAt)) return 'changes';
  if (newest && !newest.approval) return 'review';
  return 'production';
}

/* One of the client's own notes (C4): what they wrote, where in the video or which
   photo (by its review key, never its file name), when the server saved it, and
   when they sent it, or null while it's still theirs to change. */
function noteView(n) {
  return {
    id: n.id,
    versionId: n.versionId,
    text: str(n.text),
    seconds: typeof n.seconds === 'number' ? n.seconds : null,
    photo: n.photoKey || null,
    createdAt: str(n.createdAt),
    submittedAt: n.submittedAt || null,
  };
}

const INVOICE_LABEL = { deposit: 'Deposit', final: 'Final invoice', single: 'Invoice' };

/* An invoice the client has been sent, as the routes found it: the number they
   were given (Hnry's once it lives there), what it asks for, and its page when it
   has one of billing's. Nothing else about the money. */
function invoiceCard(inv) {
  return {
    id: inv.id,
    label: INVOICE_LABEL[inv.kind] || 'Invoice',
    number: str(inv.number),
    state: inv.state,
    issuedOn: str(inv.issuedOn),
    dueOn: str(inv.dueOn),
    paidOn: str(inv.paidOn),
    amount: Number(inv.amount) || 0,
    url: inv.url || null,
  };
}

/* One project, with what the client has been given on its checklist: items the
   studio marked not needed, and versions not yet published, aren't theirs to see.
   `reviewOf(version)` gives each version's review copy, built at reply time and
   never stored (C2): { type: 'hls', url, poster } for a video ready on Bunny Stream
   (Bunny Slice 4), { type: 'file', url } for one played from the NAS, { type:
   'photos', urls } for a photo library, or null when there's no file to show (an old
   hub link). Nothing here offers a download. A version's `bunny` row stays here:
   only what reviewOf builds from it goes out.
   `invoices` (C3): the ones actually sent, through invoiceCard. `agreement`: the
   signed quote's page and when it was signed, or null when it wasn't signed here.
   `hourlyRate` (C5): the rate as the signed agreement wrote it ("$63.00"), for the
   rounds-used notice, or null when there's no signed agreement saying one. Each item
   has its revision `rounds` (used counts Finals only), each version when it was
   approved (`approvedAt`, and `deemed` when the studio marked it after the contract's
   14 business days, C7). Who, the IP and the device stay with the studio. */
function projectView(project, checklist, {
  reviewOf = () => null, invoices = [], agreement = null, clientId = null, hourlyRate = null,
} = {}) {
  return {
    ...projectCard(project),
    invoices: invoices.map(invoiceCard),
    agreement: agreement ? { url: agreement.url, signedOn: str(agreement.signedOn) } : null,
    hourlyRate: hourlyRate ? str(hourlyRate) : null,
    deliverables: checklist.filter((d) => !d.notNeededAt).map((d) => ({
      id: d.id,
      title: str(d.title),
      stage: d.stage,
      status: itemStatus(d),
      rounds: { included: delivery().ROUNDS_INCLUDED, used: Number(d.roundsUsed) || 0 },
      // This client's own notes on the item, every version's, oldest first.
      notes: (d.notes || []).filter((n) => n.clientId === clientId).map(noteView),
      versions: d.versions.filter((v) => v.publishedAt).map((v) => ({
        id: v.id,
        n: v.n,
        stage: v.stage,
        kind: v.kind,
        photoCount: Number(v.photoCount) || 0,
        publishedAt: v.publishedAt,
        submittedAt: v.submittedAt || null,
        approvedAt: v.approval ? str(v.approval.approvedAt) : null,
        deemed: Boolean(v.approval && v.approval.kind === 'deemed'),
        review: reviewOf(v),
      })),
    })),
  };
}

module.exports = { clientView, projectCard, projectView, noteView, itemStatus };
