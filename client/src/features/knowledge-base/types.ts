export interface KnowledgeItem {
  id: string;
  title: string;
}

export type KnowledgeDocumentStatus = 'pending' | 'success' | 'error' | string;

export interface KnowledgeDocument {
  id: string;
  name: string;
  file_name: string;
  item_count: number;
  status: KnowledgeDocumentStatus;
  items?: KnowledgeItem[];
  folderId: string;
  folder_id: string;
  detail_text?: string;
}

export interface KnowledgeFolder {
  id: string;
  name: string;
  documents?: KnowledgeDocument[];
}

export interface KnowledgeBaseIndex {
  folders: KnowledgeFolder[];
  documents: KnowledgeDocument[];
}

export interface KnowledgeBaseEvent {
  type: string;
}