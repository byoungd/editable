import { Element } from '@editablejs/editor'
import { ALIGN_ATTR_KEY } from '../constants'

type ValueOf<T> = T[keyof T]

export interface AlignValue {
  Left: 'left'
  Center: 'center'
  Right: 'right'
  Justify: 'justify'
}

export type AlignKeys = ValueOf<typeof AlignValue>

export const AlignValue: AlignValue = {
  Left: 'left',
  Center: 'center',
  Right: 'right',
  Justify: 'justify',
}

export interface Align extends Element {
  textAlign: AlignKeys
}

export const Align = {
  isAlign: (value: any): value is Align => {
    return Element.isElement(value) && ALIGN_ATTR_KEY in value
  },
}
