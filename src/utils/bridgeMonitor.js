const config = require('config');
const axios = require('axios');
const cron = require('node-cron');
const logger = require('winston');
const { AdminTypes } = require('../models/pledgeAdmins.model');
const { DonationStatus, DONATION_BRIDGE_STATUS } = require('../models/donations.model');
const { ZERO_ADDRESS } = require('../blockchain/lib/web3Helpers');

const bridgeMonitorBaseUrl = config.get('bridgeMonitorBaseUrl');
const getDonationStatusFromBridge = async ({ txHash }) => {
  /**
   * If you want to see an example of bridge monitor response you can check this link
   * @see{@link https://feathers.bridge.beta.giveth.io/payments?event.returnValues.reference=0xe5f676f6d24fbe43feddb80dcebbedf86e35835b1c5dd984cda46faff73dd98a}
   * @type {*}
   */
  const result = await axios.get(`${bridgeMonitorBaseUrl}/payments`, {
    params: {
      'event.returnValues.reference': txHash,
    },
  });
  if (result.data && result.data.data && result.data.data.length >= 0) {
    return result.data.data[0];
  }
  return undefined;
};

const updateMilestoneStatusToPaid = async (app, donation) => {
  const donationService = app.service('donations');
  const milestoneService = app.service('milestones');
  const milestone = await milestoneService.get(donation.ownerTypeId);
  const { maxAmount, reviewerAddress, fullyFunded } = milestone;

  // never set uncapped or without-reviewer non-fullyFunded milestones as PAID
  const hasReviewer = reviewerAddress && reviewerAddress !== ZERO_ADDRESS;
  if (!maxAmount || (!fullyFunded && !hasReviewer)) return;
  const donations = await donationService.find({
    paginate: false,
    query: {
      ownerTypeId: donation.ownerTypeId,
      status: { $in: [DonationStatus.COMMITTED, DonationStatus.PAYING, DonationStatus.PAID] },
      amountRemaining: { $ne: '0' },
    },
  });

  // if there are still committed and paying donations, don't mark the as paid or paying
  if (
    donations.some(d => d.status === DonationStatus.COMMITTED || d.status === DonationStatus.PAYING)
  ) {
    return;
  }

  const hasDonationWithPendingStatusInBridge = donations.some(
    d =>
      d.bridgeStatus !== DONATION_BRIDGE_STATUS.PAID &&
      d.bridgeStatus !== DONATION_BRIDGE_STATUS.CANCELLED,
  );
  if (!hasDonationWithPendingStatusInBridge) {
    await app.service('milestones').patch(donation.ownerTypeId, {
      isAllDonationsPaidInBridge: true,
    });
    // TODO can email to milestone owner and says that the money went to their wallet
  }
};

const updateDonationsAndMilestoneStatusToBridgePaid = async ({ app, donation, bridgeEvent }) => {
  const donationService = app.service('donations');
  const bridgeStatus = DONATION_BRIDGE_STATUS.PAID;
  await donationService.patch(donation._id, {
    bridgeStatus,
    bridgeTxHash: bridgeEvent.transactionHash,
  });
  logger.info('update donation bridge status', {
    donationId: donation._id,
    bridgeStatus,
  });
  if (donation.ownerType === AdminTypes.MILESTONE) {
    await updateMilestoneStatusToPaid(app, donation);
  }
};
const updateDonationsAndMilestoneStatusToBridgeFailed = async ({ app, donation, bridgeEvent }) => {
  const donationService = app.service('donations');
  const bridgeStatus = DONATION_BRIDGE_STATUS.CANCELLED;
  await donationService.patch(donation._id, {
    bridgeStatus,
    bridgeTxHash: bridgeEvent.transactionHash,
  });
  logger.info('update donation bridge status', {
    donationId: donation._id,
    bridgeStatus,
  });
  if (donation.ownerType === AdminTypes.MILESTONE) {
    // TODO I dont know what should to do with milestone in this case
  }
};
const updateDonationsAndMilestoneStatusToBridgeUnknown = async ({ app, donation }) => {
  const donationService = app.service('donations');
  let bridgeStatus = DONATION_BRIDGE_STATUS.UNKNOWN;
  const timeBetweenCreatedDonationAndNow =
    new Date().getTime() - new Date(donation.createdAt).getTime();
  const threshold = 60 * 24 * 3600 * 1000;
  if (timeBetweenCreatedDonationAndNow > threshold) {
    bridgeStatus = DONATION_BRIDGE_STATUS.EXPIRED;
  }
  donationService.patch(donation._id, {
    bridgeStatus,
  });
  logger.info('update donation bridge status', {
    donationId: donation._id,
    bridgeStatus,
  });
};

const updateDonationsStatusesWithBridge = async app => {
  const donationService = app.service('donations');
  // */5 * * * * means every 5 minute
  cron.schedule('*/5 * * * *', async () => {
    const donations = await donationService.find({
      paginate: false,
      query: {
        $limit: 100,
        // TODO add filter for createdAt to less than 72 hours ago
        status: DonationStatus.PAID,
        bridgeStatus: {
          // $exists: true,
          $nin: [
            DONATION_BRIDGE_STATUS.PAID,
            DONATION_BRIDGE_STATUS.CANCELLED,
            DONATION_BRIDGE_STATUS.EXPIRED,
          ],
        },
      },
    });
    logger.info(
      'updateDonationsStatusesWithBridge cronjob executed, donationsCount:',
      donations.length,
    );
    // eslint-disable-next-line no-restricted-syntax
    for (const donation of donations) {
      // eslint-disable-next-line no-await-in-loop
      const payment = await getDonationStatusFromBridge({ txHash: donation.txHash });
      if (payment && payment.paid) {
        // eslint-disable-next-line no-await-in-loop
        await updateDonationsAndMilestoneStatusToBridgePaid({
          app,
          donation,
          bridgeEvent: payment.event,
        });
      } else if (payment && payment.canceled) {
        // eslint-disable-next-line no-await-in-loop
        await updateDonationsAndMilestoneStatusToBridgeFailed({
          app,
          donation,
          bridgeEvent: payment.event,
        });
      } else {
        // eslint-disable-next-line no-await-in-loop
        await updateDonationsAndMilestoneStatusToBridgeUnknown({
          app,
          donation,
        });
      }
    }
  });
};

module.exports = {
  getDonationStatusFromBridge,
  updateDonationsStatusesWithBridge,
};
