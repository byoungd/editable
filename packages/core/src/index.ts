import type { ISelection } from '@editablejs/selection';
import Selection from '@editablejs/selection';
import { isServer, Log } from '@editablejs/utils';
import { EVENT_VALUE_CHANGE, EVENT_KEYDOWN, EVENT_KEYUP, EVENT_NODE_UPDATE, EVENT_COMPOSITION_START, EVENT_COMPOSITION_END } from '@editablejs/constants';
import type { IModel, INode, NodeData, NodeKey, Op } from '@editablejs/model'
import Model, { Element, Text } from '@editablejs/model'
import EventEmitter from '@editablejs/event-emitter';
import type { CompositionUpdateCallback, EditorOptions, IChange, IEditor, NodeUpdateCallback, PluginOptions, PluginRender } from './types';
import type { ITyping } from './typing/types';
import Typing from './typing';
import Change from './change';

type IPluginMap = Map<string, PluginOptions>

type CompositionUpdateParams = {
  chars: Record<"type" | "text", string>[];
  text: string;
  offset: number;
}

const _pluginMap: IPluginMap = new Map();
class Editor extends EventEmitter implements IEditor {

  private pluginMap: IPluginMap = new Map();
  protected updateMap: Map<string, NodeUpdateCallback> = new Map();
  protected compositionUpdateMap: Map<string, CompositionUpdateCallback> = new Map();
  private _isComposition = false
  private _compositionInfo?: Record<'key' | 'text', string>
  private _cacheCompositionUpdate: Map<string, CompositionUpdateParams> = new Map()
  selection: ISelection;
  model: IModel
  change: IChange
  typing: ITyping

  /**
   * 创建编辑器
   * @param options 
   * @returns 
   */
  static create = (options?: EditorOptions) => {
    return new Editor(options);
  }
  
  /**
   * 注册插件
   * @param name 
   * @param options 
   */
  static registerPlugin = <E extends NodeData = NodeData, T extends INode<E> = INode<E>>(type: string, options: PluginOptions<E, T> | PluginRender<E, T>): void => {
    if(typeof options === 'function') { 
      options = {
        render: options
      }
    }
    _pluginMap.set(type, options as unknown as PluginOptions)
  }

  constructor(options?: EditorOptions){
    super()
    const { enabledPlugins, disabledPlugins } = options ?? {}
    if(enabledPlugins) {
      enabledPlugins.forEach(name => {
        const pluginOptions = _pluginMap.get(name)
        if(pluginOptions) {
          this.registerPlugin(name, pluginOptions)
        }
      })
    } else { 
      _pluginMap.forEach((plugin, name) => { 
        if(!disabledPlugins || disabledPlugins.includes(name)) {
          this.registerPlugin(name, plugin)
        }
      })
    }

    const model = new Model()
    const selection = new Selection({
      model
    });
    const change = new Change(model, selection)
    const typing = new Typing(this)
    
    model.on(EVENT_NODE_UPDATE, this.emitUpdate)
    
    selection.on(EVENT_VALUE_CHANGE, (value: string) => {
      if(!selection.isCollapsed) {
        change.deleteContents()
      }
      if(this.isComposition) {
        this.emitCompositionUpdate(value)
      } else {
        change.insertText(value)
      }
    })
    selection.on(EVENT_KEYDOWN, typing.emitKeydown)
    selection.on(EVENT_KEYUP, typing.emitKeyup)
    selection.on(EVENT_COMPOSITION_START, () => {
      this._isComposition = true
    })
    selection.on(EVENT_COMPOSITION_END, (ev: CompositionEvent) => {
      this._isComposition = false
      if(this._compositionInfo) { 
        const callback = this.compositionUpdateMap.get(this._compositionInfo.key)
        if(callback) callback(null)
      }
      this._compositionInfo = undefined
      change.insertText(ev.data)
    })
    this.model = model
    this.selection = selection
    this.change = change
    this.typing = typing
  }

  get isComposition() {
    return this._isComposition
  }

  registerPlugin = <E extends NodeData = NodeData, T extends INode<E> = INode<E>>(name: string, options: PluginOptions<E, T> | PluginRender<E, T>): void => {
    if(typeof options === 'function') { 
      options = {
        render: options
      }
    }
    this.pluginMap.set(name, options as unknown as PluginOptions)
  }

  renderPlugin = <E extends NodeData = NodeData, T extends INode<E> = INode<E>>(node: T): any => {
    const type = node.getType()
    const plugin = this.pluginMap.get(type)
    if(!plugin) Log.pluginNotFound(type)
    const next: ((renderNode: INode) => any) = renderNode => {
      if(!Element.isElement(renderNode)) return
      const children = renderNode.getChildren()
      return children.map((child) => {
        return this.renderPlugin(child)
      })
    };
    return plugin.render({
      node,
      next,
      editor: this
    })
  }

  onUpdate = <E extends NodeData = NodeData, T extends INode<E> = INode<E>>(key: NodeKey, callback: NodeUpdateCallback<E, T>) => {
    this.updateMap.set(key, callback as any);
  }

  offUpdate = (key: NodeKey) => { 
    this.updateMap.delete(key);
  }

  private emitUpdate = <E extends NodeData = NodeData, T extends INode<E> = INode<E>>(node: T, ops: Op[]) =>{ 
    if(Element.isElement(node)) {
      const children = node.getChildren()
      children.forEach(child => {
        this.emitUpdate(child, ops.filter(op => op.key === child.getKey()))
      })
    }
    const key = node.getKey()
    let callback = this.updateMap.get(key)
    if(callback) {
      callback(node, ops)
    }
    callback = this.updateMap.get('*')
    if(callback) {
      callback(node, ops)
    }
    // update composition position
    if(this._compositionInfo?.key === key) {
      this.emitCompositionUpdate(this._compositionInfo.text)
    }
  }

  onCompositionUpdate = (key: NodeKey, callback: CompositionUpdateCallback) => {
    const cache = this._cacheCompositionUpdate.get(key)
    if(cache) callback(cache)
    this.compositionUpdateMap.set(key, callback);
  }

  offCompositionUpdate = (key: NodeKey) => { 
    this._cacheCompositionUpdate.delete(key)
    this.compositionUpdateMap.delete(key);
  }

  didCompositionUpdate = (textNode: globalThis.Text) => {
    const range = document.createRange()
    range.selectNodeContents(textNode)
    range.collapse(false)
    const rect = range.getClientRects().item(0)
    if(!rect) return
    this.selection.clearSelection()
    this.selection.drawCaretByRect(rect.toJSON())
  }

  private emitCompositionUpdate = (text: string) => { 
    const change = this.change
    if(change.hasCacheFormatting()) {
      change.insertText('')
    }
    const range = change.getRange()
    if(!range) return
    const { key, offset } = range.anchor
    this._compositionInfo = {
      key,
      text
    }
    const node = this.model.getNode(key)
    if(!node || !Text.isText(node)) return
    
    const nodeText = node.getText()
    const chars: Record<'type' | 'text', string>[] = []
    chars.push({
      type: 'text',
      text: nodeText.substring(0, offset)
    })
    chars.push({
      type: 'composition',
      text
    })
    if(offset < nodeText.length) { 
      chars.push({
        type: 'text',
        text: nodeText.substring(offset)
      })
    }
    const callback = this.compositionUpdateMap.get(key)
    const params = {
      chars, text, offset
    }
    if(callback) {
      this._cacheCompositionUpdate.delete(key)
      callback(params)
    } else {
      this._cacheCompositionUpdate.set(key, params)
    }
  }

  destroy(){ 
    this.updateMap.clear()
    this.pluginMap.clear()
    this.model.destroy()
    this.selection.destroy()
  }
}

export default Editor;
if(!isServer) {
  window.Editable = {
    Editor,
    Element,
    Text
  }
}
export * from '@editablejs/model'
export * from '@editablejs/constants'
export * from './types'