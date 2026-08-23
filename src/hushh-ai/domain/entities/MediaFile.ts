/**
 * MediaFile Entity
 * Pure business object with NO dependencies on React or GcpBackend
 */
export class MediaFile {
  constructor(
    public readonly id: string,
    public readonly fileName: string,
    public readonly fileType: string,
    public readonly fileSize: number,
    public readonly url: string,
    public readonly thumbnailUrl?: string
  ) {}

  isImage(): boolean {
    return this.fileType.startsWith('image/');
  }

  isPDF(): boolean {
    return this.fileType === 'application/pdf';
  }

  isVideo(): boolean {
    return this.fileType.startsWith('video/');
  }

  getSizeInMB(): number {
    return this.fileSize / (1024 * 1024);
  }

  getFileExtension(): string {
    const parts = this.fileName.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  }
}
