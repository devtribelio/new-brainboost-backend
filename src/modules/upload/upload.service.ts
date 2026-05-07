import path from 'node:path';
import { extname } from 'node:path';
import { env } from '@/config/env';
import { BadRequestException } from '@/common/exceptions';

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.cpl', '.dll', '.scr', '.msi', '.msp', '.mst',
  '.vbs', '.vbe', '.wsf', '.wsh', '.ps1', '.psm1', '.psd1', '.ps1xml', '.psc1',
  '.psc2', '.jse', '.js', '.jar', '.sh', '.bash', '.zsh', '.fish', '.csh',
  '.tcsh', '.ksh', '.ade', '.adp', '.app', '.application', '.appref-ms', '.asp',
  '.aspx', '.cer', '.chm', '.crt', '.csh', '.diagcab', '.fxp', '.gadget', '.hlp',
  '.hpj', '.hta', '.htc', '.inf', '.ins', '.isp', '.its', '.lnk', '.mad', '.maf',
  '.mag', '.mam', '.maq', '.mar', '.mas', '.mat', '.mau', '.mav', '.maw',
  '.mcf', '.mda', '.mdb', '.mde', '.mdt', '.mdw', '.mdz', '.php', '.php3', '.php4',
  '.php5', '.phtml', '.pl', '.py', '.pyc', '.pyo', '.rb',
]);

export interface UploadedItem {
  filename: string;
  size: number;
  fileId: string;
  status: 'success';
  message: 'OK';
  url: string;
  fullUrl: string;
  type: string;
}

export class UploadService {
  uploadTemporary(files: Express.Multer.File[]): UploadedItem[] {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files received in field "image"');
    }

    return files.map((f) => {
      const ext = extname(f.originalname).toLowerCase();
      if (BLOCKED_EXTENSIONS.has(ext)) {
        throw new BadRequestException(`File extension "${ext}" is not allowed`);
      }

      const fileId = path.basename(f.filename);
      const url = `/static/temporary/${fileId}`;
      const base = env.upload.publicBaseUrl || `${env.baseUrl}`;
      const fullUrl = `${base.replace(/\/$/, '')}${url}`;

      return {
        filename: f.originalname,
        size: f.size,
        fileId,
        status: 'success',
        message: 'OK',
        url,
        fullUrl,
        type: f.mimetype,
      };
    });
  }
}
