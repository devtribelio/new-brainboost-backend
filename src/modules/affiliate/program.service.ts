import { prisma } from '@/config/prisma';
import { NotFoundException, BadRequestException } from '@/common/exceptions';
import { generateUniqueProgramCode } from './utils/code-generator';

export class AffiliateProgramService {
  async listActive() {
    return prisma.affiliateProgram.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
      include: { product: true },
    });
  }

  async findByCode(code: string) {
    const program = await prisma.affiliateProgram.findUnique({
      where: { code },
      include: { product: true },
    });
    if (!program) throw new NotFoundException(`Affiliate program "${code}" not found`);
    return program;
  }

  async findById(id: string) {
    const program = await prisma.affiliateProgram.findUnique({
      where: { id },
      include: { product: true },
    });
    if (!program) throw new NotFoundException(`Affiliate program ${id} not found`);
    return program;
  }

  async create(input: { name: string; productId?: string | null; isActive?: boolean }) {
    if (!input.name?.trim()) throw new BadRequestException('Program name is required');

    const code = await generateUniqueProgramCode(async (candidate) => {
      const existing = await prisma.affiliateProgram.findUnique({ where: { code: candidate } });
      return existing === null;
    });

    return prisma.affiliateProgram.create({
      data: {
        code,
        name: input.name.trim(),
        productId: input.productId ?? null,
        isActive: input.isActive ?? true,
      },
    });
  }

  async update(id: string, input: { name?: string; productId?: string | null; isActive?: boolean }) {
    return prisma.affiliateProgram.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.productId !== undefined ? { productId: input.productId } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
  }

  async deactivate(id: string) {
    return prisma.affiliateProgram.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
