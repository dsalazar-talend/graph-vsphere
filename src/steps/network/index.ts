import {
  createDirectRelationship,
  IntegrationStep,
  IntegrationStepExecutionContext,
  IntegrationWarnEventName,
  RelationshipClass,
} from '@jupiterone/integration-sdk-core';

import { getOrCreateAPIClient } from '../../client';
import { IntegrationConfig } from '../../config';
import { Steps, Entities, Relationships } from '../constants';
import { createNetworkEntity, getNetworkKey } from './converter';

export async function fetchNetworks({
  instance,
  jobState,
  logger,
}: IntegrationStepExecutionContext<IntegrationConfig>) {
  const apiClient = getOrCreateAPIClient(instance.config, logger);

  await apiClient.iterateNetworks(async (network) => {
    await jobState.addEntity(createNetworkEntity(network));
  });
}

export async function buildVmNetworkRelationship({
  instance,
  jobState,
  logger,
}: IntegrationStepExecutionContext<IntegrationConfig>) {
  const apiClient = getOrCreateAPIClient(instance.config, logger);
  let vmQuerySuccessCount: number = 0;
  let vmQueryFailCount: number = 0;

  await jobState.iterateEntities(
    { _type: Entities.VIRTUAL_MACHINE._type },
    async (vmEntity) => {
      const vm = await apiClient.getVm(vmEntity.vm as string);
      try {
        for (const nics of Object.values(vm.nics)) {
          // Depending on version, we may need to slightly modify where
          // we're pulling network information from.
          if (!nics.backing) {
            nics.backing = nics.value.backing;
          }
          const networkEntity = await jobState.findEntity(
            getNetworkKey(nics.backing.network),
          );

          if (networkEntity) {
            const vmUsesNetwork = createDirectRelationship({
              _class: RelationshipClass.USES,
              from: vmEntity,
              to: networkEntity,
            });
            // We need to check that the relationship doesn't yet exist
            // for those instances where a VM has multiple nics on the
            // same network.
            if (!jobState.hasKey(vmUsesNetwork._key)) {
              await jobState.addRelationship(vmUsesNetwork);
            }
          }
        }
      } catch (err) {
        logger.info(`Unable to query vcenter/vm/${vmEntity.vm as string} endpoint.`,);
        vmQueryFailCount++;
      }
    },
  );
  if (vmQueryFailCount > 0) {
    logger.publishWarnEvent({
      name: IntegrationWarnEventName.MissingPermission,
      description: `Could not query all VM information for VMs.  Success = ${vmQuerySuccessCount}  Failed = ${vmQueryFailCount}`,
    });
  }
}

export const networkSteps: IntegrationStep<IntegrationConfig>[] = [
  {
    id: Steps.NETWORK,
    name: 'Fetch Network',
    entities: [Entities.NETWORK],
    relationships: [],
    dependsOn: [Steps.HOST],
    executionHandler: fetchNetworks,
  },
  {
    id: Steps.BUILD_VM_NETWORK,
    name: 'Build VM and Network Relationship',
    entities: [],
    relationships: [Relationships.VM_USES_NETWORK],
    dependsOn: [Steps.VM, Steps.NETWORK],
    executionHandler: buildVmNetworkRelationship,
  },
];
