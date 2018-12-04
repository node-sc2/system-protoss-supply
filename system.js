'use strict';

const debugSilly = require('debug')('sc2:silly:supplySystem');
const { createSystem } = require('@node-sc2/core');
const { Alliance } = require('@node-sc2/core/constants/enums');
const { frontOfNatural } = require('@node-sc2/core/utils/map/region');
const { SupplyUnitRace } = require('@node-sc2/core/constants/race-map');
const { distance, areEqual, avgPoints, nClosestPoint } = require('@node-sc2/core/utils/geometry/point');

function calculateSupplyGap(gameLoop, supply, bases) {
    // increase supply gap as supply gets higher
    const supplyMultiplier = supply / 40 < 1 ? 1 : supply / 40;
    // increase supply gap as we expand
    const baseMultiplier = bases.length >= 4 ? 4 : bases.length;
    const gap = 4 * baseMultiplier * supplyMultiplier;
    debugSilly('Calculated supply gap desired: ', Math.floor(gap));
    return Math.floor(gap);
}

 /** @type {AgentSystem} */
const SupplySystem = {
    name: 'SupplySystem',
    type: 'agent',
    setup() {
        this.setState({ supplyUnits: 0 });
    },
    /** @param {World} world */
    findSupplyPositions({ agent, resources }) {
        const { units, map, debug } = resources.get();

        const [main, natural] = map.getExpansions();
        const myExpansions = map.getOccupiedExpansions(Alliance.SELF);
        const myPylons = units.getById(SupplyUnitRace[agent.race]);

        // first pylon being placed
        if (this.state.supplyUnits === 0) {
            const mainMineralLine = main.areas.mineralLine;
            const geysers = main.cluster.vespeneGeysers;

            const mainBase = main.getBase();
            const locations = main.areas.areaFill.filter((point) => {
                return (
                    // with-in super pylon distance from main nexus
                    (distance(point, mainBase.pos) <= 6.5) &&
                    // far enough away to stay outta the mineral line
                    (mainMineralLine.every(mlp => distance(mlp, point) > 2)) &&
                    // far enough away from gas line
                    (geysers.every(gp => distance(gp.pos, point) > 3))
                );
            });

            return locations;
        }

        if (this.state.supplyUnits === 1) {
            // front of natural pylon for great justice
            const fON = frontOfNatural(map.getExpansions());

            // only get the points close enough for a super pylon
            const placements = fON.filter((point) => {
                const thD = distance(point, natural.townhallPosition);
                
                return (
                    // within super pylon distance, and friends, not lovers
                    (thD < 6.5) && (thD > 4.5) &&
                    // not in mineral line
                    natural.areas.mineralLine.every(p => !areEqual(p, point))
                );
            });

            const closestToAvg = nClosestPoint(avgPoints(placements), placements, 10);

            // const avgFON = avgPoints(fON);

            // debug.setDrawCells('frontOfNatural', closestToAvg, natural.zPosition);
            // debug.setDrawTextWorld('frontOfNatLabel', [{ pos: avgFON, text: 'FRONT OF NATURAL', color: WHITE}]);
            // debug.updateScreen();
            return closestToAvg;
        }

        const needsSuperPylon = myExpansions.find((expansion) => {
            const expansionBase = expansion.getBase();
            
            return !myPylons.some(pylon => distance(expansionBase.pos, pylon.pos) < 6.5);
        });

        if (needsSuperPylon) {
            const baseWhichNeedsSuperPylon = needsSuperPylon.getBase();

            return needsSuperPylon.areas.placementGrid.filter((point) => {
                return (
                    distance(point, baseWhichNeedsSuperPylon.pos) < 6.5 &&
                    distance(point, baseWhichNeedsSuperPylon.pos) > 3.5
                );
            });
        }

        // behind mineral line pylons, for canons and things, every base should have one if it can fit
        const needsBmlPylon = myExpansions.find((expansion) => {
            return (
                // no existing bml pylon
                !myPylons.some((pylon) => {
                    return expansion.areas.behindMineralLine.some(point => areEqual(pylon.pos, point));
                }) &&
                // label prevents getting stuck retrying where it doesn't fit
                !expansion.labels.has('attemptedBML')
            );
        });

        if (needsBmlPylon) {
            needsBmlPylon.labels.set('attemptedBML', true);
            const bml =  needsBmlPylon.areas.behindMineralLine;
            const bmlCentroid = avgPoints(bml);

            return bml.filter(point => distance(point, bmlCentroid) < 5);
        } else {
            // otherwise just return all points in main and nat
            return [ ...main.areas.placementGrid, ...natural.areas.placementGrid];
        }
    },
    async onStep({ agent, data, resources }, gameLoop) {
        const { units, actions } = resources.get();

        const supplyUnitId = SupplyUnitRace[agent.race];
        const bases = units.getBases(Alliance.SELF);
        const buildAbilityId = data.getUnitTypeData(supplyUnitId).abilityId;

        const { foodUsed: supply, foodCap } = agent;

        // current supplyCap includes pylons currently building and existing orders given to build them
        const supplyCap = (
            foodCap +
            (units.inProgress(supplyUnitId).length * 8) + 
            (units.withCurrentOrders(buildAbilityId).length * 8)
        );

        if (supplyCap >= 200) return;

        const conditions = [
            supplyCap - supply < calculateSupplyGap(gameLoop, supply, bases), // need more supply gap
            agent.canAfford(supplyUnitId), // can afford to build a pylon
        ];

        if (conditions.every(c => c)) {
            const positions = this.findSupplyPositions({ agent, data, resources });

            // pick 10 random positions from the list
            const randomPositions = positions
                .map(pos => ({ pos, rand: Math.random() }))
                .sort((a, b) => a.rand - b.rand)
                .map(a => a.pos)
                .slice(0, 20);

            // see if any of them are good
            const foundPosition = await actions.canPlace(supplyUnitId, randomPositions);

            if (foundPosition) {
                await actions.build(supplyUnitId, foundPosition);
                this.setState({ supplyUnits: this.state.supplyUnits + 1 });
            }
        }
    }
};

module.exports = createSystem(SupplySystem);
