import createSyncTaskQueue from 'sync-task-queue'

import type { Folder, Folders, FolderMessages } from '~/core/store'
import { FOLDER_POSTFIX } from '~/tools/handle-content'

import {
  transformFolder,
  sortFolders,
  sortMessages,
  transformMessage
} from './api.helpers'
import { apiCache } from './api.cache'

export const updatesQueue = createSyncTaskQueue()

export const handleUpdates = async (
  data: {
    chats?
    messages?
    update?
    updates?
  },
  options?: {
    new?: boolean
    deleted?: boolean
    edited?: boolean
    offsetId?: number
  }
): Promise<{
  folders?: Folders
}> => updatesQueue.enqueue(async () => {
  const { chats, messages, update, updates } = data
  let folders
  let foldersMessages
  let searchMessages

  if (chats?.length) {
    folders = await handleChats(chats)
  }
  if (messages?.length) {
    [foldersMessages, searchMessages] = await Promise.all([
      handleMessages(messages, options),
      handleSearchMessages(messages, options),
    ])
  }
  if (update) {
    [foldersMessages, searchMessages] = await handleMessagesUpdates([update])
  }
  if (updates?.length) {
    [foldersMessages, searchMessages] = await handleMessagesUpdates(updates)
  }

  return {
    folders,
    foldersMessages,
    searchMessages
  }
})

const handleMessagesUpdates = async (messagesUpdates) => {
  let foldersMessages
  let searchMessages

  for (let i = 0; i < messagesUpdates.length; i++) {
    const { _, message, messages } = messagesUpdates[i]

    if (['updateNewMessage', 'updateNewChannelMessage'].includes(_)) {
      foldersMessages = await handleMessages([message], { new: true }) || foldersMessages
    }

    if (['updateDeleteMessages', 'updateDeleteChannelMessages'].includes(_)) {
      [foldersMessages = foldersMessages, searchMessages] = await Promise.all([
        handleMessages(messages, { deleted: true }),
        handleSearchMessages(messages, { deleted: true })
      ])
    }

    if (['updateEditMessage', 'updateEditChannelMessage'].includes(_)) {
      [foldersMessages = foldersMessages, searchMessages] = await Promise.all([
        handleMessages([message], { edited: true }),
        handleSearchMessages([message], { edited: true })
      ])
    }
  }

  return [foldersMessages, searchMessages]
}

const handleChats = async (chats): Promise<Folders> => {
  const cachedFolders = await apiCache.getFolders()
  const updatedFolders: Folder[] = []
  const updatedFolderIds: number[] = []

  chats.forEach(chat => {
    const { _, title, left, general } = chat
    if (general || title.endsWith(FOLDER_POSTFIX)) {
      updatedFolderIds.push(chat.id)

      if (!left && !_?.endsWith('Forbidden')) {
        updatedFolders.push(transformFolder(chat))
      }
    }
  })

  const sortedFolders: Folder[] = sortFolders([
    ...[...cachedFolders.values()].filter(({ id }) =>
      !updatedFolderIds.includes(id)
    ),
    ...updatedFolders
  ])
  const folders = new Map(sortedFolders.map(folder => [folder.id, folder]))

  await apiCache.setFolders(folders)

  return folders
}

const handleMessages = async (
  messages,
  options?: {
    new?: boolean
    deleted?: boolean
    edited?: boolean
    offsetId?: number
  }
) => {
  const user = await apiCache.getUser()
  const [folders, foldersMessages] = await Promise.all([
    apiCache.getFolders(),
    apiCache.getFoldersMessages()
  ])
  const updates: Map<number, { folderMessages: FolderMessages, isSorted: boolean }> = new Map()

  messages.forEach(async (message, index) => {
    const { _, peer_id } = message
    const { channel_id, user_id, chat_id } = peer_id
    const folderId: number = channel_id || user_id || chat_id

    const folderMessages: FolderMessages =
      (options?.offsetId === 0 && index === 0) ? new Map() :
        (foldersMessages.get(folderId) || new Map())

    let isUpdated = false
    let isSorted = true

    if (_ === 'message' && folders.has(folderId)) {
      message = !options?.deleted ? transformMessage(message, user) : message

      if (options?.deleted && folderMessages.has(message.id)) {
        folderMessages.delete(message.id)
        isUpdated = true
      } else if (options?.edited && folderMessages.has(message.id)) {
        folderMessages.set(message.id, message)
        isUpdated = true
      } else if (typeof options?.offsetId === 'number') {
        folderMessages.set(message.id, message)
        isUpdated = true
        isSorted = false
      } else if (options?.new) {
        folderMessages.set(message.id, message)
        isUpdated = true
        isSorted = false
      }
    }

    if (isUpdated) {
      foldersMessages.set(folderId, folderMessages)
      updates.set(folderId, {
        folderMessages,
        isSorted: isSorted ? (updates.get(folderId)?.isSorted ?? true) : false
      })
    }
  })

  if (!updates.size) return

  await Promise.all([...updates].map(([folderId, { folderMessages, isSorted }]) => {
    if (!isSorted) {
      folderMessages = new Map(sortMessages([...folderMessages]))
      foldersMessages.set(folderId, folderMessages)
    }
    return apiCache.setFolderMessages(folderId, folderMessages)
  }))

  return foldersMessages
}

const handleSearchMessages = async (
  messages,
  options?: {
    deleted?: boolean
    edited?: boolean
  }
) => {
  let updated = false
  const user = await apiCache.getUser()
  const searchMessages = await apiCache.getSearchMessages()

  messages.forEach(message => {
    if (searchMessages.has(message.id)) {
      if (options?.deleted) {
        searchMessages.delete(message.id)
        updated = true
      }

      if (options?.edited) {
        searchMessages.set(message.id, transformMessage(message, user))
        updated = true
      }
    }
  })

  if (updated) {
    apiCache.setSearchMessages(searchMessages)
    return new Map(searchMessages)
  } else {
    return undefined
  }
}
