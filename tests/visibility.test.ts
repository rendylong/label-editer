import { describe, expect, it } from 'vitest'
import type { PartNode } from '../src/label/types'
import * as viewport from '../src/scene/Viewport'

describe('3D 部件显隐映射', () => {
  it('把部件树内部 id 转换为 three 场景节点名称', () => {
    const parts: PartNode[] = [
      {
        id: 'n0',
        name: 'Root',
        kind: 'group',
        visible: true,
        children: [
          { id: 'n8', name: 'Object_9', kind: 'mesh', visible: true, children: [], meshIndex: 7 },
        ],
      },
    ]
    const resolve = (viewport as unknown as {
      resolveHiddenNodeNames?: (nodes: PartNode[], ids: Set<string>) => Set<string>
    }).resolveHiddenNodeNames

    expect(resolve?.(parts, new Set(['n8']))).toEqual(new Set(['Object_9']))
  })
})
