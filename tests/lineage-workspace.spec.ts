import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildLineageWorkspaceApi } from '../src/lineage-workspace-route.ts'

describe('lineage workspace persistence', () => {
  let cwd = ''
  let save: NonNullable<ReturnType<typeof buildLineageWorkspaceApi>['lineage.workspace.save']>
  let list: NonNullable<ReturnType<typeof buildLineageWorkspaceApi>['lineage.workspace.list']>
  let get: NonNullable<ReturnType<typeof buildLineageWorkspaceApi>['lineage.workspace.get']>
  let remove: NonNullable<ReturnType<typeof buildLineageWorkspaceApi>['lineage.workspace.delete']>
  let restore: NonNullable<ReturnType<typeof buildLineageWorkspaceApi>['lineage.workspace.restore']>

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'lineage-workspace-'))
    const api = buildLineageWorkspaceApi(async () => ({ cwd }))
    save = api['lineage.workspace.save']!
    list = api['lineage.workspace.list']!
    get = api['lineage.workspace.get']!
    remove = api['lineage.workspace.delete']!
    restore = api['lineage.workspace.restore']!
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('saves, lists, loads, and deletes a workspace', async () => {
    const payload = { sessionId: 'session', name: '订单履约本体血缘图', graph: { nodes: [], edges: [] } }
    const created = await save(payload) as { workspace: { id: string } }
    const listed = await list(payload) as { workspaces: { id: string; name: string; nodeCount: number }[] }
    expect(listed.workspaces).toHaveLength(1)
    expect(listed.workspaces[0]?.name).toBe('订单履约本体血缘图')

    await save({
      ...payload,
      id: created.workspace.id,
      name: '客户主数据图谱',
      graph: { nodes: [{ id: 'n1', label: '客户', type: 'class' }], edges: [] },
    })
    const loaded = await get({ ...payload, id: created.workspace.id }) as {
      workspace: { name: string; nodes: unknown[] }
    }
    expect(loaded.workspace.name).toBe('客户主数据图谱')
    expect(loaded.workspace.nodes).toHaveLength(1)

    await save({
      ...payload,
      id: created.workspace.id,
      name: '客户主数据图谱',
      source: 'import',
      graph: { nodes: [{ id: 'n2', label: '订单', type: 'class' }], edges: [] },
    })
    const versioned = await get({ ...payload, id: created.workspace.id }) as {
      workspace: { revisions: { id: string; source: string }[] }
    }
    expect(versioned.workspace.revisions).toHaveLength(3)
    const targetRevision = versioned.workspace.revisions.find((revision) => revision.source === 'import')
    const restored = await restore({
      ...payload,
      id: created.workspace.id,
      revisionId: targetRevision!.id,
    }) as { workspace: { nodes: { id: string }[]; revisions: unknown[] } }
    expect(restored.workspace.nodes).toHaveLength(1)
    expect(restored.workspace.revisions).toHaveLength(4)

    await remove({ ...payload, id: created.workspace.id })
    const deleted = await list(payload) as { workspaces: unknown[] }
    expect(deleted.workspaces).toHaveLength(0)
  })

  it('writes JSON beside the session project', async () => {
    await save({ sessionId: 'session', name: '设备血缘图', graph: { nodes: [], edges: [] } })
    await expect(readFile(join(cwd, '.dsh', 'lineage-workspaces.json'), 'utf8')).resolves.toContain('设备血缘图')
  })
})
