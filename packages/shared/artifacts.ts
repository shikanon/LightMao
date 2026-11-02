export interface ProjectArtifact {
  id: string;
  projectId: string;
  path: string;
  name: string;
  kind: 'image' | 'video' | 'audio' | 'model' | 'text';
  mime: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
}
