import type { ObjectVersion, OperationInput, ProposeChangeOutput } from '@kalyth/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Clock } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ApiError } from '../api/client.ts'
import { api, keys, useCommitProposal, useProposal, useTypes } from '../api/queries.ts'
import { useWorkbench } from '../app/workbench.ts'
import { useToast } from '../components/toast.tsx'
import { Button, Spinner } from '../components/ui.tsx'
import { objectLabel } from '../model/labels.ts'
import { describeOps } from '../model/ops.ts'
import { objectTypeMeta } from '../model/semantics.ts'
import { AppLink, ErrorNotice, IssueList } from '../views/shared.tsx'
import {
  ADDABLE_TYPES,
  type AddableType,
  addElementOps,
  addElementRationale,
  allowedRelationTypes,
  allowedTargets,
  attachedRelations,
  connectOps,
  connectRationale,
  containerCandidates,
  currentName,
  draftProblems,
  HTTP_METHODS,
  renameField,
  renameOps,
  renameRationale,
  retireOps,
  retireRationale,
  type Stance,
} from './edits.ts'
import { OFF_CANVAS_TYPES } from './projection.ts'

/**
 * Editing on the canvas creates a proposal, as every other change does (ADR 0020). Each form
 * builds operations with the claim basis `stated`, submits them as a pending proposal, and shows
 * what was proposed with its provenance. A person then commits it now or leaves it pending for
 * review in the Proposals view. Nothing changes the model without that commit.
 */

export type EditKind = 'add' | 'rename' | 'connect' | 'retire'

interface Proposed {
  output: ProposeChangeOutput
  rationale: string
}

function useProposeEdit() {
  const wb = useWorkbench()
  const client = useQueryClient()
  return useMutation<Proposed, ApiError, { rationale: string; ops: OperationInput[] }>({
    mutationFn: async ({ rationale, ops }) => ({
      output: await api.propose(wb.projectId, { baseRevision: wb.revision, rationale, ops }),
      rationale,
    }),
    onSettled: () => client.invalidateQueries({ queryKey: keys.proposals(wb.projectId) }),
  })
}

/** A modal dialog that opens while `open` is true and gives focus back when it closes. */
function EditDialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    } else if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(540px,calc(100vw-2rem))] border border-fg bg-surface p-0 text-fg shadow-pop"
    >
      {open && (
        <div className="space-y-3 p-5">
          <h2 id={titleId} className="font-semibold text-[15px]">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  )
}

const fieldClass =
  'h-8 w-full rounded-sm border border-border-strong bg-surface px-2 text-sm text-fg placeholder:text-fg-subtle'
const labelClass = 'block space-y-1'
const labelText = 'block font-medium text-xs'

function StanceField({ value, onChange }: { value: Stance; onChange: (s: Stance) => void }) {
  const name = useId()
  return (
    <fieldset className="space-y-1">
      <legend className={labelText}>What it describes</legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={name}
          checked={value === 'toBe'}
          onChange={() => onChange('toBe')}
          className="mt-1 accent-[var(--k-accent)]"
        />
        <span>Intended (to-be): a proposed design, drawn as a dashed draft</span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={name}
          checked={value === 'asIs'}
          onChange={() => onChange('asIs')}
          className="mt-1 accent-[var(--k-accent)]"
        />
        <span>Exists today (as-is), as you state it; analysis has not observed it</span>
      </label>
    </fieldset>
  )
}

function Provenance() {
  return (
    <p className="border-accent border-l-2 pl-2 text-fg-muted text-xs">
      Stated by you; not in the model until committed. It becomes a pending proposal that you, or
      another reviewer, commit or reject.
    </p>
  )
}

function FormButtons({
  onCancel,
  submitLabel,
  disabled,
  pending,
}: {
  onCancel: () => void
  submitLabel: string
  disabled: boolean
  pending: boolean
}) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <Button onClick={onCancel}>Cancel</Button>
      <Button type="submit" variant="primary" disabled={disabled || pending}>
        {pending && <Spinner label="Proposing" />}
        {submitLabel}
      </Button>
    </div>
  )
}

// ---------- the forms ----------

function AddElementForm({
  onDone,
  onCancel,
  within: initialWithin,
}: {
  onDone: (p: Proposed) => void
  onCancel: () => void
  within: string | undefined
}) {
  const wb = useWorkbench()
  const types = useTypes()
  const propose = useProposeEdit()
  const [type, setType] = useState<AddableType>('software.Container')
  const [name, setName] = useState('')
  const [method, setMethod] = useState('GET')
  const [within, setWithin] = useState(initialWithin ?? '')
  const [stance, setStance] = useState<Stance>('toBe')
  const candidates = useMemo(
    () =>
      containerCandidates(types.data?.relationTypes ?? [], type, wb.model?.objects ?? []).sort(
        (a, b) => objectLabel(a).localeCompare(objectLabel(b), 'en'),
      ),
    [types.data, type, wb.model],
  )
  const withinValid = within === '' || candidates.some((c) => c.id === within)
  const draft = {
    type,
    name,
    stance,
    ...(type === 'software.Endpoint' ? { method } : {}),
    ...(within && withinValid ? { within } : {}),
  }
  const problems = draftProblems(draft)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (problems.length > 0) return
    propose.mutate(
      { rationale: addElementRationale(draft), ops: addElementOps(draft) },
      { onSuccess: onDone },
    )
  }
  const ids = { type: useId(), name: useId(), method: useId(), within: useId() }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className={labelClass}>
        <label htmlFor={ids.type} className={labelText}>
          Type
        </label>
        <select
          id={ids.type}
          value={type}
          onChange={(e) => setType(e.target.value as AddableType)}
          className={`select-control ${fieldClass}`}
        >
          {ADDABLE_TYPES.map((t) => (
            <option key={t} value={t}>
              {objectTypeMeta(t).label}
            </option>
          ))}
        </select>
      </div>
      {type === 'software.Endpoint' ? (
        <div className="grid grid-cols-[110px_1fr] gap-2">
          <div className={labelClass}>
            <label htmlFor={ids.method} className={labelText}>
              Method
            </label>
            <select
              id={ids.method}
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className={`select-control ${fieldClass}`}
            >
              {HTTP_METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className={labelClass}>
            <label htmlFor={ids.name} className={labelText}>
              Path
            </label>
            <input
              id={ids.name}
              data-autofocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="/visits/{id}"
              className={`${fieldClass} font-mono`}
              maxLength={1000}
            />
          </div>
        </div>
      ) : (
        <div className={labelClass}>
          <label htmlFor={ids.name} className={labelText}>
            Name
          </label>
          <input
            id={ids.name}
            data-autofocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldClass}
            maxLength={300}
          />
        </div>
      )}
      <div className={labelClass}>
        <label htmlFor={ids.within} className={labelText}>
          Inside (optional)
        </label>
        <select
          id={ids.within}
          value={withinValid ? within : ''}
          onChange={(e) => setWithin(e.target.value)}
          className={`select-control ${fieldClass}`}
        >
          <option value="">Not inside another element</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {objectTypeMeta(c.type).label}: {objectLabel(c)}
              {c.stance === 'toBe' ? ' (proposed)' : ''}
            </option>
          ))}
        </select>
      </div>
      <StanceField value={stance} onChange={setStance} />
      <Provenance />
      {name.trim() !== '' && problems.length > 0 && (
        <ul className="text-tone-fg text-xs tone-danger">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {propose.isError && <ErrorNotice error={propose.error} />}
      <FormButtons
        onCancel={onCancel}
        submitLabel="Propose element"
        disabled={problems.length > 0}
        pending={propose.isPending}
      />
    </form>
  )
}

function RenameForm({
  object,
  onDone,
  onCancel,
}: {
  object: ObjectVersion
  onDone: (p: Proposed) => void
  onCancel: () => void
}) {
  const propose = useProposeEdit()
  const [name, setName] = useState(currentName(object))
  const field = renameField(object)
  const trimmed = name.trim()
  const unchanged = trimmed === currentName(object)
  const invalid =
    trimmed === '' ||
    (field === 'path' && object.type === 'software.Endpoint' && !trimmed.startsWith('/'))
  const id = useId()
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (invalid || unchanged) return
        propose.mutate(
          { rationale: renameRationale(object, trimmed), ops: renameOps(object, trimmed) },
          { onSuccess: onDone },
        )
      }}
    >
      <div className={labelClass}>
        <label htmlFor={id} className={labelText}>
          New {field ?? 'name'}
        </label>
        <input
          id={id}
          data-autofocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={`${fieldClass} ${field === 'path' ? 'font-mono' : ''}`}
          maxLength={field === 'path' ? 1000 : 300}
        />
      </div>
      {object.claim.basis === 'observed' && (
        <p className="text-fg-muted text-xs">
          The analyzer observed this element. After the rename its claim is what you state; a later
          analysis of the source may report it again under the observed name.
        </p>
      )}
      <Provenance />
      {propose.isError && <ErrorNotice error={propose.error} />}
      <FormButtons
        onCancel={onCancel}
        submitLabel="Propose rename"
        disabled={invalid || unchanged}
        pending={propose.isPending}
      />
    </form>
  )
}

function ConnectForm({
  object,
  onDone,
  onCancel,
}: {
  object: ObjectVersion
  onDone: (p: Proposed) => void
  onCancel: () => void
}) {
  const wb = useWorkbench()
  const types = useTypes()
  const propose = useProposeEdit()
  const allowed = useMemo(
    () => allowedRelationTypes(types.data?.relationTypes ?? [], object),
    [types.data, object],
  )
  const [type, setType] = useState('')
  const descriptor = allowed.find((d) => d.type === type) ?? allowed[0]
  const targets = useMemo(
    () =>
      descriptor
        ? allowedTargets(
            descriptor,
            object,
            (wb.model?.objects ?? []).filter(
              (o) => o.lifecycle === 'active' && !OFF_CANVAS_TYPES.has(o.type),
            ),
          ).sort((a, b) => objectLabel(a).localeCompare(objectLabel(b), 'en'))
        : [],
    [descriptor, object, wb.model],
  )
  const [target, setTarget] = useState('')
  const [stance, setStance] = useState<Stance>(object.stance === 'toBe' ? 'toBe' : 'toBe')
  const to = targets.find((t) => t.id === target)
  const ids = { type: useId(), target: useId() }
  if (types.isLoading) return <Spinner label="Loading the relation types" />
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!descriptor || !to) return
        propose.mutate(
          {
            rationale: connectRationale(object, to, descriptor.type),
            ops: connectOps(object, to, descriptor.type, stance),
          },
          { onSuccess: onDone },
        )
      }}
    >
      {allowed.length === 0 ? (
        <p className="text-fg-muted text-sm">
          The type registry allows no relation from a{' '}
          {objectTypeMeta(object.type).label.toLowerCase()}.
        </p>
      ) : (
        <>
          <div className={labelClass}>
            <label htmlFor={ids.type} className={labelText}>
              Relation
            </label>
            <select
              id={ids.type}
              value={descriptor?.type ?? ''}
              onChange={(e) => {
                setType(e.target.value)
                setTarget('')
              }}
              className={`select-control ${fieldClass}`}
            >
              {allowed.map((d) => (
                <option key={d.type} value={d.type}>
                  {d.type}: {d.description}
                </option>
              ))}
            </select>
          </div>
          <div className={labelClass}>
            <label htmlFor={ids.target} className={labelText}>
              To
            </label>
            <select
              id={ids.target}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className={`select-control ${fieldClass}`}
            >
              <option value="">Choose an element ({targets.length})</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {objectTypeMeta(t.type).label}: {objectLabel(t)}
                  {t.stance === 'toBe' ? ' (proposed)' : ''}
                </option>
              ))}
            </select>
          </div>
          <StanceField value={stance} onChange={setStance} />
        </>
      )}
      <Provenance />
      {propose.isError && <ErrorNotice error={propose.error} />}
      <FormButtons
        onCancel={onCancel}
        submitLabel="Propose relation"
        disabled={!descriptor || !to}
        pending={propose.isPending}
      />
    </form>
  )
}

function RetireForm({
  object,
  onDone,
  onCancel,
}: {
  object: ObjectVersion
  onDone: (p: Proposed) => void
  onCancel: () => void
}) {
  const wb = useWorkbench()
  const propose = useProposeEdit()
  const [reason, setReason] = useState('')
  const attached = attachedRelations(object, wb.model?.relations ?? [])
  const decisionLinks = attached.filter((r) => {
    const other = wb.model?.objectById.get(r.from === object.id ? r.to : r.from)
    return other !== undefined && OFF_CANVAS_TYPES.has(other.type)
  })
  const trimmed = reason.trim()
  const id = useId()
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!trimmed) return
        propose.mutate(
          {
            rationale: retireRationale(object, trimmed),
            ops: retireOps(object, wb.model?.relations ?? [], trimmed),
          },
          { onSuccess: onDone },
        )
      }}
    >
      <p className="text-fg-muted text-sm">
        Retiring keeps “{objectLabel(object)}” in the history and removes it from the model from the
        next revision.
        {attached.length > 0 &&
          ` Its ${attached.length} active relation${attached.length === 1 ? ' is' : 's are'} retired with it.`}
      </p>
      {decisionLinks.length > 0 && (
        <p className="tone-caution border border-tone-bd bg-tone-bg px-2 py-1.5 text-tone-fg text-xs">
          {decisionLinks.length === 1
            ? 'One of them links'
            : `${decisionLinks.length} of them link`}{' '}
          it to decisions, alternatives or questions (
          {[...new Set(decisionLinks.map((r) => r.type))].join(', ')}). Those records stay, but no
          longer point at this element.
        </p>
      )}
      <div className={labelClass}>
        <label htmlFor={id} className={labelText}>
          Reason (required)
        </label>
        <textarea
          id={id}
          data-autofocus
          required
          rows={3}
          maxLength={2000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full resize-y rounded-sm border border-border-strong bg-surface px-2 py-1.5 text-sm"
        />
      </div>
      <Provenance />
      {propose.isError && <ErrorNotice error={propose.error} />}
      <FormButtons
        onCancel={onCancel}
        submitLabel="Propose retirement"
        disabled={!trimmed}
        pending={propose.isPending}
      />
    </form>
  )
}

// ---------- confirmation ----------

function Confirmation({ proposed, onClose }: { proposed: Proposed; onClose: () => void }) {
  const wb = useWorkbench()
  const notify = useToast()
  const { proposalId, status, issues } = proposed.output
  const proposal = useProposal(proposalId)
  const commit = useCommitProposal(wb.projectId)
  const ops = proposal.data?.ops
  const lines = useMemo(
    () => (ops ? describeOps(ops, (id) => wb.model?.nameOf(id)) : []),
    [ops, wb.model],
  )
  if (status !== 'pending') {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          The proposal was stored as <strong>{status}</strong>, so it cannot be committed. Nothing
          changed in the model.
        </p>
        <div className="tone-danger">
          <IssueList issues={issues} resolveName={(id) => wb.model?.nameOf(id)} />
        </div>
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    )
  }
  const committed = commit.isSuccess
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Pending proposal: <span className="font-medium">{proposed.rationale}</span>
      </p>
      <section aria-label="Proposed operations" className="border border-border">
        <h3 className="border-border border-b bg-surface-2 px-2 py-1 font-mono text-[10px] text-fg-subtle uppercase tracking-[0.08em]">
          Operations · basis stated
        </h3>
        {proposal.isLoading ? (
          <div className="p-2">
            <Spinner label="Loading the proposal" />
          </div>
        ) : (
          <ol className="divide-y divide-border text-sm">
            {lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: operations are an immutable, ordered list
              <li key={i} className="px-2 py-1.5">
                <span className="font-medium">{line.verb}</span> {line.subject}
                {line.detail && <span className="block text-fg-muted text-xs">{line.detail}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
      {committed ? (
        <p className="flex items-center gap-1.5 text-sm">
          <Check aria-hidden className="size-4 text-accent" /> Committed. The model now includes it.
        </p>
      ) : (
        <Provenance />
      )}
      {commit.isError && (
        <ErrorNotice error={commit.error} resolveName={(id) => wb.model?.nameOf(id)} />
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <AppLink to={{ view: 'proposals', proposal: proposalId }} className="mr-auto text-sm">
          Open in Proposals
        </AppLink>
        {committed ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>
              <Clock aria-hidden /> Leave pending
            </Button>
            <Button
              variant="primary"
              disabled={commit.isPending}
              onClick={() =>
                commit.mutate(proposalId, {
                  onSuccess: (result) =>
                    notify({
                      tone: 'success',
                      title: `Committed at revision ${result.revision}`,
                      body: proposed.rationale,
                    }),
                })
              }
            >
              {commit.isPending ? <Spinner label="Committing" /> : <Check aria-hidden />}
              Commit now
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

const TITLES: Record<EditKind, string> = {
  add: 'Add an element',
  rename: 'Rename',
  connect: 'Connect to another element',
  retire: 'Retire',
}

/** The edit dialog: a form, then the confirmation of what was proposed. */
export function EditFlow({
  kind,
  object,
  within,
  onClose,
}: {
  kind: EditKind | null
  object: ObjectVersion | undefined
  within: string | undefined
  onClose: () => void
}) {
  const [proposed, setProposed] = useState<Proposed | null>(null)
  useEffect(() => {
    if (kind === null) setProposed(null)
  }, [kind])
  const close = () => {
    setProposed(null)
    onClose()
  }
  const subject = object ? ` “${objectLabel(object)}”` : ''
  const title = proposed
    ? proposed.output.status === 'pending'
      ? 'Proposal submitted'
      : 'Proposal refused'
    : `${TITLES[kind ?? 'add']}${kind === 'add' ? '' : subject}`
  return (
    <EditDialog open={kind !== null} title={title} onClose={close}>
      {proposed ? (
        <Confirmation proposed={proposed} onClose={close} />
      ) : kind === 'add' ? (
        <AddElementForm onDone={setProposed} onCancel={close} within={within} />
      ) : kind === 'rename' && object ? (
        <RenameForm object={object} onDone={setProposed} onCancel={close} />
      ) : kind === 'connect' && object ? (
        <ConnectForm object={object} onDone={setProposed} onCancel={close} />
      ) : kind === 'retire' && object ? (
        <RetireForm object={object} onDone={setProposed} onCancel={close} />
      ) : null}
    </EditDialog>
  )
}
