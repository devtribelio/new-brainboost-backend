import { prisma } from '@bb/db';
import { logger } from '@/config/logger';
import { notificationEvents } from '@/common/events/notification-events';
import { NotificationProducer } from '../notification.producer';
import { RecipientResolver } from '../recipient.resolver';
import { ActionLabel, NotifGroup } from '../action-labels';

const producer = new NotificationProducer();
const resolver = new RecipientResolver();

async function teamMemberIds(networkId: string, exclude?: string): Promise<string[]> {
  const rows = await prisma.networkTeamMember.findMany({
    where: { networkId, ...(exclude ? { memberId: { not: exclude } } : {}) },
    select: { memberId: true },
  });
  return resolver.filterEnabled(rows.map((r) => r.memberId));
}

export function registerNetworkNotificationListener(): void {
  notificationEvents.on('network.member.requested', async (e) => {
    try {
      const [network, requester, teamIds] = await Promise.all([
        prisma.network.findUnique({ where: { id: e.networkId }, select: { name: true } }),
        prisma.member.findUnique({ where: { id: e.memberId }, select: { fullName: true } }),
        teamMemberIds(e.networkId, e.memberId),
      ]);
      if (!network || !requester || teamIds.length === 0) return;

      await producer.createForMany(
        teamIds,
        {
          type: ActionLabel.RequestJoin,
          notifGroup: NotifGroup.Creator,
          networkId: e.networkId,
          title: `${requester.fullName} requested to join ${network.name}`,
          payload: {
            refTable: 'network_member_request',
            refId: e.requestId,
            networkId: e.networkId,
            memberId: e.memberId,
          },
        },
        `requestJoin:${e.requestId}`,
      );
    } catch (err) {
      logger.error({ err, requestId: e.requestId }, '[notification] network.requested listener failed');
    }
  });

  notificationEvents.on('network.member.approved', async (e) => {
    try {
      const [network, approver] = await Promise.all([
        prisma.network.findUnique({ where: { id: e.networkId }, select: { name: true } }),
        prisma.member.findUnique({ where: { id: e.approverId }, select: { fullName: true } }),
      ]);
      if (!network || !approver) return;

      await producer.createForMember({
        memberId: e.memberId,
        type: ActionLabel.ApproveJoin,
        notifGroup: NotifGroup.General,
        networkId: e.networkId,
        title: `Your request to join ${network.name} was approved`,
        body: `Approved by ${approver.fullName}`,
        payload: {
          refTable: 'network',
          refId: e.networkId,
          requestId: e.requestId,
          approverId: e.approverId,
        },
        dedupeKey: `approveJoin:${e.requestId}`,
      });
    } catch (err) {
      logger.error({ err, requestId: e.requestId }, '[notification] network.approved listener failed');
    }
  });

  notificationEvents.on('network.member.joined', async (e) => {
    try {
      const [network, member, teamIds] = await Promise.all([
        prisma.network.findUnique({ where: { id: e.networkId }, select: { name: true } }),
        prisma.member.findUnique({ where: { id: e.memberId }, select: { fullName: true } }),
        teamMemberIds(e.networkId, e.memberId),
      ]);
      if (!network || !member || teamIds.length === 0) return;

      await producer.createForMany(
        teamIds,
        {
          type: ActionLabel.MemberJoin,
          notifGroup: NotifGroup.Creator,
          networkId: e.networkId,
          title: `${member.fullName} joined ${network.name}`,
          payload: {
            refTable: 'network_member',
            refId: e.networkId,
            networkId: e.networkId,
            memberId: e.memberId,
          },
        },
        `memberJoin:${e.networkId}:${e.memberId}`,
      );
    } catch (err) {
      logger.error({ err, networkId: e.networkId }, '[notification] network.joined listener failed');
    }
  });
}
