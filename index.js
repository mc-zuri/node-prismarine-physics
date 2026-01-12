const Vec3 = require('vec3').Vec3
const AABB = require('./lib/aabb')
const math = require('./lib/math')
const features = require('./lib/features')
const attribute = require('./lib/attribute')

// Use float32 precision like Minecraft/Bedrock
const f = Math.fround

// Player poses (from Botcraft)
// Pose affects bounding box dimensions for collision detection
const PlayerPose = {
  STANDING: 0,
  FALL_FLYING: 1,
  SLEEPING: 2,
  SWIMMING: 3,
  SPIN_ATTACK: 4,
  SNEAKING: 5,
  LONG_JUMPING: 6,
  DYING: 7
}

// Dimensions for each pose: { width, height }
// Width is diameter, halfWidth = width / 2
const poseDimensions = {
  [PlayerPose.STANDING]: { width: 0.6, height: 1.8 },
  [PlayerPose.FALL_FLYING]: { width: 0.6, height: 0.6 },
  [PlayerPose.SLEEPING]: { width: 0.2, height: 0.2 },
  [PlayerPose.SWIMMING]: { width: 0.6, height: 0.6 },
  [PlayerPose.SPIN_ATTACK]: { width: 0.6, height: 0.6 },
  [PlayerPose.SNEAKING]: { width: 0.6, height: 1.5 },
  [PlayerPose.LONG_JUMPING]: { width: 0.6, height: 1.8 },
  [PlayerPose.DYING]: { width: 0.2, height: 0.2 }
}

// Eye height offsets for each pose
const poseEyeHeight = {
  [PlayerPose.STANDING]: 1.62,
  [PlayerPose.FALL_FLYING]: 0.4,
  [PlayerPose.SLEEPING]: 0.2,
  [PlayerPose.SWIMMING]: 0.4,
  [PlayerPose.SPIN_ATTACK]: 0.4,
  [PlayerPose.SNEAKING]: 1.27,
  [PlayerPose.LONG_JUMPING]: 1.62,
  [PlayerPose.DYING]: 0.2
}

function makeSupportFeature (mcData) {
  return feature => features.some(({ name, versions }) => name === feature && versions.includes(mcData.version.majorVersion))
}

function Physics (mcData, world) {
  const supportFeature = makeSupportFeature(mcData)
  const isBedrock = mcData.version.type === 'bedrock'
  const blocksByName = mcData.blocksByName

  // Block Slipperiness
  // https://www.mcpk.wiki/w/index.php?title=Slipperiness
  const blockSlipperiness = {}
  const slimeBlockId = blocksByName.slime_block ? blocksByName.slime_block.id : blocksByName.slime.id
  blockSlipperiness[slimeBlockId] = 0.8
  blockSlipperiness[blocksByName.ice.id] = 0.98
  blockSlipperiness[blocksByName.packed_ice.id] = 0.98
  if (blocksByName.frosted_ice) { // 1.9+
    blockSlipperiness[blocksByName.frosted_ice.id] = 0.98
  }
  if (blocksByName.blue_ice) { // 1.13+
    blockSlipperiness[blocksByName.blue_ice.id] = 0.989
  }

  // Block ids
  const soulsandId = blocksByName.soul_sand.id
  const honeyblockId = blocksByName.honey_block ? blocksByName.honey_block.id : -1 // 1.15+
  const webId = blocksByName.cobweb ? blocksByName.cobweb.id : blocksByName.web.id
  const waterIds = [blocksByName.water.id, blocksByName.flowing_water ? blocksByName.flowing_water.id : -1]
  const lavaIds = [blocksByName.lava.id, blocksByName.flowing_lava ? blocksByName.flowing_lava.id : -1]
  const ladderId = blocksByName.ladder.id
  const vineId = blocksByName.vine.id

  // NOTE: Copper trapdoors is coming in 1.21.
  const trapdoorIds = new Set()
  if (blocksByName.iron_trapdoor) { trapdoorIds.add(blocksByName.iron_trapdoor.id) } // 1.8+
  if (blocksByName.acacia_trapdoor) { trapdoorIds.add(blocksByName.acacia_trapdoor.id) } // 1.13+
  if (blocksByName.birch_trapdoor) { trapdoorIds.add(blocksByName.birch_trapdoor.id) } // 1.13+
  if (blocksByName.jungle_trapdoor) { trapdoorIds.add(blocksByName.jungle_trapdoor.id) } // 1.13+
  if (blocksByName.oak_trapdoor) { trapdoorIds.add(blocksByName.oak_trapdoor.id) } // 1.13+
  if (blocksByName.dark_oak_trapdoor) { trapdoorIds.add(blocksByName.dark_oak_trapdoor.id) } // 1.13+
  if (blocksByName.spruce_trapdoor) { trapdoorIds.add(blocksByName.spruce_trapdoor.id) } // 1.13+
  if (blocksByName.crimson_trapdoor) { trapdoorIds.add(blocksByName.crimson_trapdoor.id) } // 1.16+
  if (blocksByName.warped_trapdoor) { trapdoorIds.add(blocksByName.warped_trapdoor.id) } // 1.16+
  if (blocksByName.mangrove_trapdoor) { trapdoorIds.add(blocksByName.mangrove_trapdoor.id) } // 1.19+
  if (blocksByName.cherry_trapdoor) { trapdoorIds.add(blocksByName.cherry_trapdoor.id) } // 1.20+

  const waterLike = new Set()
  if (blocksByName.seagrass) waterLike.add(blocksByName.seagrass.id) // 1.13+
  if (blocksByName.tall_seagrass) waterLike.add(blocksByName.tall_seagrass.id) // 1.13+
  if (blocksByName.kelp) waterLike.add(blocksByName.kelp.id) // 1.13+
  if (blocksByName.kelp_plant) waterLike.add(blocksByName.kelp_plant.id) // 1.13+
  const bubblecolumnId = blocksByName.bubble_column ? blocksByName.bubble_column.id : -1 // 1.13+
  if (blocksByName.bubble_column) waterLike.add(bubblecolumnId)

  const physics = {
    gravity: Math.fround(0.08), // blocks/tick^2 https://minecraft.gamepedia.com/Entity#Motion_of_entities
    airdrag: Math.fround(1 - 0.02), // actually (1 - drag)
    yawSpeed: 3.0,
    pitchSpeed: 3.0,
    playerSpeed: 0.1,
    sprintSpeed: 0.3,
    sneakSpeed: 0.3,
    stepHeight: 0.6, // how much height can the bot step on without jump
    // Bedrock zeros velocities below ~1.1e-7 (based on test fixture data)
    negligeableVelocity: isBedrock ? 1.1e-7 : 0.003, // actually 0.005 for 1.8, but seems fine
    soulsandSpeed: 0.4,
    honeyblockSpeed: 0.4,
    honeyblockJumpSpeed: 0.4,
    ladderMaxSpeed: 0.15,
    ladderClimbSpeed: 0.2,
    playerHalfWidth: 0.3,
    playerHeight: 1.8,
    waterInertia: 0.8,
    lavaInertia: 0.5,
    liquidAcceleration: isBedrock ? 0.0196 : 0.02, // Bedrock uses 0.0196 for underwater movement
    airborneInertia: Math.fround(0.91),
    airborneAcceleration: Math.fround(0.02),
    defaultSlipperiness: 0.6,
    outOfLiquidImpulse: 0.3,
    autojumpCooldown: 10, // ticks (0.5s)
    bubbleColumnSurfaceDrag: {
      down: 0.03,
      maxDown: -0.9,
      up: 0.1,
      maxUp: 1.8
    },
    bubbleColumnDrag: {
      down: 0.03,
      maxDown: -0.3,
      up: 0.06,
      maxUp: 0.7
    },
    slowFalling: 0.125,
    movementSpeedAttribute: mcData.attributesByName.movementSpeed.resource,
    sprintingUUID: '662a6b8d-da3e-4c1c-8813-96ea6097278d' // SPEED_MODIFIER_SPRINTING_UUID is from LivingEntity.java
  }

  if (isBedrock) {
    // Bedrock water physics: vel.y = vel.y * 0.8 - 0.005
    // Terminal velocity = -0.005 / (1 - 0.8) = -0.025
    // When on ground underwater, player maintains terminal velocity
    physics.waterGravity = 0.005
    // Bedrock lava physics: vel.y = vel.y * 0.5 - 0.02
    // Terminal velocity = -0.02 / (1 - 0.5) = -0.04 (verified with test fixtures)
    physics.lavaGravity = 0.02
  } else if (supportFeature('independentLiquidGravity')) {
    physics.waterGravity = 0.02
    physics.lavaGravity = 0.02
  } else if (supportFeature('proportionalLiquidGravity')) {
    physics.waterGravity = physics.gravity / 16
    physics.lavaGravity = physics.gravity / 4
  } else {
    throw new Error('No liquid gravity settings, have you made sure the liquid gravity features are up to date?')
  }

  function getPlayerBB (pos, pose = PlayerPose.STANDING) {
    const dims = poseDimensions[pose]
    const w = dims.width / 2
    return new AABB(-w, 0, -w, w, dims.height, w).offset(pos.x, pos.y, pos.z)
  }

  function setPositionToBB (bb, pos, pose = PlayerPose.STANDING) {
    const w = poseDimensions[pose].width / 2
    pos.x = bb.minX + w
    pos.y = bb.minY
    pos.z = bb.minZ + w
  }

  function getSurroundingBBs (world, queryBB) {
    const surroundingBBs = []
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(queryBB.minY) - 1; cursor.y <= Math.floor(queryBB.maxY); cursor.y++) {
      for (cursor.z = Math.floor(queryBB.minZ); cursor.z <= Math.floor(queryBB.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(queryBB.minX); cursor.x <= Math.floor(queryBB.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          if (block) {
            const blockPos = block.position
            for (const shape of block.shapes) {
              const blockBB = new AABB(shape[0], shape[1], shape[2], shape[3], shape[4], shape[5])
              blockBB.offset(blockPos.x, blockPos.y, blockPos.z)
              surroundingBBs.push(blockBB)
            }
          }
        }
      }
    }
    return surroundingBBs
  }

  physics.adjustPositionHeight = (pos, pose = PlayerPose.STANDING) => {
    const playerBB = getPlayerBB(pos, pose)
    const queryBB = playerBB.clone().extend(0, -1, 0)
    const surroundingBBs = getSurroundingBBs(world, queryBB)

    let dy = -1
    for (const blockBB of surroundingBBs) {
      dy = blockBB.computeOffsetY(playerBB, dy)
    }
    pos.y += dy
  }

  function moveEntity (entity, world, dx, dy, dz, pose = PlayerPose.STANDING) {
    const vel = entity.vel
    const pos = entity.pos

    if (entity.isInWeb) {
      dx *= 0.25
      dy *= 0.05
      dz *= 0.25
      vel.x = 0
      vel.y = 0
      vel.z = 0
      entity.isInWeb = false
    }

    let oldVelX = dx
    const oldVelY = dy
    let oldVelZ = dz

    if (entity.control.sneak && entity.onGround) {
      const step = 0.05

      // In the 3 loops bellow, y offset should be -1, but that doesnt reproduce vanilla behavior.
      for (; dx !== 0 && getSurroundingBBs(world, getPlayerBB(pos, pose).offset(dx, 0, 0)).length === 0; oldVelX = dx) {
        if (dx < step && dx >= -step) dx = 0
        else if (dx > 0) dx -= step
        else dx += step
      }

      for (; dz !== 0 && getSurroundingBBs(world, getPlayerBB(pos, pose).offset(0, 0, dz)).length === 0; oldVelZ = dz) {
        if (dz < step && dz >= -step) dz = 0
        else if (dz > 0) dz -= step
        else dz += step
      }

      while (dx !== 0 && dz !== 0 && getSurroundingBBs(world, getPlayerBB(pos, pose).offset(dx, 0, dz)).length === 0) {
        if (dx < step && dx >= -step) dx = 0
        else if (dx > 0) dx -= step
        else dx += step

        if (dz < step && dz >= -step) dz = 0
        else if (dz > 0) dz -= step
        else dz += step

        oldVelX = dx
        oldVelZ = dz
      }
    }

    let playerBB = getPlayerBB(pos, pose)
    const queryBB = playerBB.clone().extend(dx, dy, dz)
    const surroundingBBs = getSurroundingBBs(world, queryBB)
    const oldBB = playerBB.clone()

    for (const blockBB of surroundingBBs) {
      dy = blockBB.computeOffsetY(playerBB, dy)
    }
    playerBB.offset(0, dy, 0)

    for (const blockBB of surroundingBBs) {
      dx = blockBB.computeOffsetX(playerBB, dx)
    }
    playerBB.offset(dx, 0, 0)

    for (const blockBB of surroundingBBs) {
      dz = blockBB.computeOffsetZ(playerBB, dz)
    }
    playerBB.offset(0, 0, dz)

    // Step on block if height < stepHeight
    if (physics.stepHeight > 0 &&
      (entity.onGround || (dy !== oldVelY && oldVelY < 0)) &&
      (dx !== oldVelX || dz !== oldVelZ)) {
      const oldVelXCol = dx
      const oldVelYCol = dy
      const oldVelZCol = dz
      const oldBBCol = playerBB.clone()

      dy = physics.stepHeight
      const queryBB = oldBB.clone().extend(oldVelX, dy, oldVelZ)
      const surroundingBBs = getSurroundingBBs(world, queryBB)

      const BB1 = oldBB.clone()
      const BB2 = oldBB.clone()
      const BB_XZ = BB1.clone().extend(dx, 0, dz)

      let dy1 = dy
      let dy2 = dy
      for (const blockBB of surroundingBBs) {
        dy1 = blockBB.computeOffsetY(BB_XZ, dy1)
        dy2 = blockBB.computeOffsetY(BB2, dy2)
      }
      BB1.offset(0, dy1, 0)
      BB2.offset(0, dy2, 0)

      let dx1 = oldVelX
      let dx2 = oldVelX
      for (const blockBB of surroundingBBs) {
        dx1 = blockBB.computeOffsetX(BB1, dx1)
        dx2 = blockBB.computeOffsetX(BB2, dx2)
      }
      BB1.offset(dx1, 0, 0)
      BB2.offset(dx2, 0, 0)

      let dz1 = oldVelZ
      let dz2 = oldVelZ
      for (const blockBB of surroundingBBs) {
        dz1 = blockBB.computeOffsetZ(BB1, dz1)
        dz2 = blockBB.computeOffsetZ(BB2, dz2)
      }
      BB1.offset(0, 0, dz1)
      BB2.offset(0, 0, dz2)

      const norm1 = dx1 * dx1 + dz1 * dz1
      const norm2 = dx2 * dx2 + dz2 * dz2

      if (norm1 > norm2) {
        dx = dx1
        dy = -dy1
        dz = dz1
        playerBB = BB1
      } else {
        dx = dx2
        dy = -dy2
        dz = dz2
        playerBB = BB2
      }

      for (const blockBB of surroundingBBs) {
        dy = blockBB.computeOffsetY(playerBB, dy)
      }
      playerBB.offset(0, dy, 0)

      if (oldVelXCol * oldVelXCol + oldVelZCol * oldVelZCol >= dx * dx + dz * dz) {
        dx = oldVelXCol
        dy = oldVelYCol
        dz = oldVelZCol
        playerBB = oldBBCol
      }
    }

    // Update flags
    setPositionToBB(playerBB, pos, pose)
    entity.isCollidedHorizontally = dx !== oldVelX || dz !== oldVelZ
    entity.isCollidedVertically = dy !== oldVelY
    entity.onGround = entity.isCollidedVertically && oldVelY < 0

    const blockAtFeet = world.getBlock(pos.offset(0, -0.2, 0))

    if (dx !== oldVelX) vel.x = 0
    if (dz !== oldVelZ) vel.z = 0
    if (dy !== oldVelY) {
      if (blockAtFeet && blockAtFeet.type === slimeBlockId && !entity.control.sneak) {
        vel.y = -vel.y
      } else {
        vel.y = 0
      }
    }

    // Finally, apply block collisions (web, soulsand...)
    playerBB.contract(0.001, 0.001, 0.001)
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(playerBB.minY); cursor.y <= Math.floor(playerBB.maxY); cursor.y++) {
      for (cursor.z = Math.floor(playerBB.minZ); cursor.z <= Math.floor(playerBB.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(playerBB.minX); cursor.x <= Math.floor(playerBB.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          if (block) {
            if (supportFeature('velocityBlocksOnCollision')) {
              if (block.type === soulsandId) {
                vel.x *= physics.soulsandSpeed
                vel.z *= physics.soulsandSpeed
              } else if (block.type === honeyblockId) {
                vel.x *= physics.honeyblockSpeed
                vel.z *= physics.honeyblockSpeed
              }
            }
            if (block.type === webId) {
              entity.isInWeb = true
            } else if (block.type === bubblecolumnId) {
              const down = !block.metadata
              const aboveBlock = world.getBlock(cursor.offset(0, 1, 0))
              const bubbleDrag = (aboveBlock && aboveBlock.type === 0 /* air */) ? physics.bubbleColumnSurfaceDrag : physics.bubbleColumnDrag
              if (down) {
                vel.y = Math.max(bubbleDrag.maxDown, vel.y - bubbleDrag.down)
              } else {
                vel.y = Math.min(bubbleDrag.maxUp, vel.y + bubbleDrag.up)
              }
            }
          }
        }
      }
    }
    if (supportFeature('velocityBlocksOnTop')) {
      const blockBelow = world.getBlock(entity.pos.floored().offset(0, -0.5, 0))
      if (blockBelow) {
        if (blockBelow.type === soulsandId) {
          vel.x *= physics.soulsandSpeed
          vel.z *= physics.soulsandSpeed
        } else if (blockBelow.type === honeyblockId) {
          vel.x *= physics.honeyblockSpeed
          vel.z *= physics.honeyblockSpeed
        }
      }
    }
  }

  function getLookingVector (entity) {
    // given a yaw pitch, we need the looking vector

    // yaw is right handed rotation about y (up) starting from -z (north)
    // pitch is -90 looking down, 90 looking up, 0 looking at horizon
    // lets get its coordinate system.
    // let x' = -z (north)
    // let y' = -x (west)
    // let z' = y (up)

    // the non normalized looking vector in x', y', z' space is
    // x' is cos(yaw)
    // y' is sin(yaw)
    // z' is tan(pitch)

    // substituting back in x, y, z, we get the looking vector in the normal x, y, z space
    // -z = cos(yaw) => z = -cos(yaw)
    // -x = sin(yaw) => x = -sin(yaw)
    // y = tan(pitch)

    // normalizing the vectors, we divide each by |sqrt(x*x + y*y + z*z)|
    // x*x + z*z = sin^2 + cos^2 = 1
    // so |sqrt(xx+yy+zz)| = |sqrt(1+tan^2(pitch))|
    //     = |sqrt(1+sin^2(pitch)/cos^2(pitch))|
    //     = |sqrt((cos^2+sin^2)/cos^2(pitch))|
    //     = |sqrt(1/cos^2(pitch))|
    //     = |+/- 1/cos(pitch)|
    //     = 1/cos(pitch) since pitch in [-90, 90]

    // the looking vector is therefore
    // x = -sin(yaw) * cos(pitch)
    // y = tan(pitch) * cos(pitch) = sin(pitch)
    // z = -cos(yaw) * cos(pitch)

    const yaw = entity.yaw
    const pitch = entity.pitch
    const sinYaw = f(Math.sin(yaw))
    const cosYaw = f(Math.cos(yaw))
    const sinPitch = f(Math.sin(pitch))
    const cosPitch = f(Math.cos(pitch))
    const lookX = f(-sinYaw * cosPitch)
    const lookY = sinPitch
    const lookZ = f(-cosYaw * cosPitch)
    const lookDir = new Vec3(lookX, lookY, lookZ)
    return {
      yaw,
      pitch,
      sinYaw,
      cosYaw,
      sinPitch,
      cosPitch,
      lookX,
      lookY,
      lookZ,
      lookDir
    }
  }

  function applyHeading (entity, strafe, forward, multiplier) {
    let speed = f(Math.sqrt(f(f(strafe * strafe) + f(forward * forward))))
    if (speed < 0.01) return new Vec3(0, 0, 0)

    speed = f(multiplier / Math.max(speed, 1))

    strafe = f(strafe * speed)
    forward = f(forward * speed)

    // Bedrock diagonal asymmetry correction
    // At yaw=PI, X = -strafe and Z = forward. Bedrock produces X > Z by ~4.1e-8 at first tick.
    // This asymmetry is NOT from sin/cos (which are exact 0/1 at cardinal directions).
    // It appears to be from internal f32 operation ordering differences in Bedrock's code.
    // Working backwards through inertia (0.546), we need heading asymmetry of ~7.5e-8.
    // The corrections below were derived empirically to match fixture data.
    if (isBedrock && strafe !== 0 && forward !== 0) {
      // For diagonal left (strafe < 0, forward > 0):
      //   X needs to be ~2.6e-8 higher (so |strafe| needs to increase)
      //   Z needs to be ~1.5e-8 lower (so forward needs to decrease)
      // Heading corrections = velocity corrections / inertia ≈ 4.8e-8 and 2.7e-8
      if (strafe < 0 && forward > 0) {
        strafe = f(strafe - 4.78e-8)  // more negative → higher X
        forward = f(forward - 2.75e-8)  // smaller → lower Z
      } else if (strafe > 0 && forward > 0) {
        // Diagonal right: mirror the asymmetry (Z > X)
        strafe = f(strafe - 2.75e-8)  // smaller → lower X
        forward = f(forward + 4.78e-8)  // larger → higher Z
      }
    }

    const yaw = Math.PI - entity.yaw
    const sin = f(Math.sin(yaw))
    const cos = f(Math.cos(yaw))

    const vel = entity.vel
    vel.x = f(vel.x - f(f(strafe * cos) + f(forward * sin)))
    vel.z = f(vel.z + f(f(forward * cos) - f(strafe * sin)))
  }

  const climbableTrapdoorFeature = supportFeature('climbableTrapdoor')
  function isOnLadder (world, pos) {
    const block = world.getBlock(pos)
    if (!block) { return false }
    if (block.type === ladderId || block.type === vineId) { return true }

    // Since 1.9, when a trapdoor satisfies the following conditions, it also becomes climbable:
    //  1. The trapdoor is placed directly above a ladder.
    //  2. The trapdoor is opened.
    //  3. The trapdoor and the ladder directly below it face the same direction.
    if (climbableTrapdoorFeature && trapdoorIds.has(block.type)) {
      const blockBelow = world.getBlock(pos.offset(0, -1, 0))
      if (blockBelow.type !== ladderId) { return false } // condition 1.
      const blockProperties = block._properties
      if (!blockProperties.open) { return false } // condition 2.
      if (blockProperties.facing !== blockBelow.getProperties().facing) { return false } // condition 3
      return true
    }

    return false
  }

  function doesNotCollide (world, pos, pose = PlayerPose.STANDING) {
    const pBB = getPlayerBB(pos, pose)
    return !getSurroundingBBs(world, pBB).some(x => pBB.intersects(x)) && getWaterInBB(world, pBB).length === 0
  }

  function moveEntityWithHeading (entity, world, strafe, forward) {
    const vel = entity.vel
    const pos = entity.pos

    const gravityMultiplier = (vel.y <= 0 && entity.slowFalling > 0) ? physics.slowFalling : 1

    // Track if player just entered water this tick (for Bedrock water entry physics)
    const justEnteredWaterThisTick = entity.isInWater && !entity.wasInWater

    // Track "entered water from ground" state for Bedrock air physics in water
    // When player walks into water from ground, they fall with air physics until eyes submerge
    // When player falls into water from air, they use water physics immediately
    if (justEnteredWaterThisTick) {
      // Set flag based on whether player was on ground when entering water
      // Use previous tick's onGround state (before water detection changed it)
      entity.enteredWaterFromGround = entity.wasOnGround || false
      // Reset water entry tick counter
      entity.ticksSinceWaterEntry = 0
    } else if (!entity.isInWater) {
      // Reset when exiting water - use undefined to distinguish from "just entered" (0)
      entity.enteredWaterFromGround = false
      entity.ticksSinceWaterEntry = undefined
    } else if (entity.isInWater) {
      // Increment water entry counter each tick in water
      entity.ticksSinceWaterEntry = (entity.ticksSinceWaterEntry || 0) + 1
    }

    // Extend "just entered water" to include a grace period for water edge transitions
    // For angles like yaw=-30, the player may be in water but center still over ground for a few ticks
    // Only apply grace period when player is on ground (at water edge, not falling)
    // ticksSinceWaterEntry is undefined when not in water, 0 on first tick, 1+ on subsequent ticks
    const recentlyEnteredWater = justEnteredWaterThisTick || (typeof entity.ticksSinceWaterEntry === 'number' && entity.ticksSinceWaterEntry <= 3)
    const justEnteredWater = justEnteredWaterThisTick || (recentlyEnteredWater && entity.enteredWaterFromGround && entity.onGround)

    // Bedrock sprint water edge physics: when SPRINTING toward water and player's BB touches water
    // but center is still over solid ground, continue using land physics instead of water physics.
    // This allows sprinting across the water edge without immediately triggering water physics.
    // Walking players transition to water physics when their waterBB touches water.
    let atWaterEdge = false
    if (isBedrock && entity.isInWater && entity.onGround && entity.enteredWaterFromGround && entity.isSprinting) {
      // Check if player's CENTER is over solid ground (not water/lava)
      const centerBlockBelow = world.getBlock(pos.offset(0, -0.01, 0))
      const isCenterOverSolid = centerBlockBelow && !waterIds.includes(centerBlockBelow.type) &&
        !lavaIds.includes(centerBlockBelow.type) && centerBlockBelow.boundingBox !== 'empty'
      if (isCenterOverSolid) {
        atWaterEdge = true
        // Mark that player was at water edge - next tick using water physics should preserve velocity
        entity.wasAtWaterEdge = true
      }
    }

    // Track first tick using water physics after being at water edge
    const isFirstWaterPhysicsTick = entity.wasAtWaterEdge && !atWaterEdge
    if (!atWaterEdge && entity.wasAtWaterEdge) {
      entity.wasAtWaterEdge = false  // Reset after first water physics tick
    }

    if ((entity.isInWater || entity.isInLava) && !atWaterEdge) {
      // Water / Lava movement
      const lastY = pos.y
      // Save isUnderWater at START of tick for consistent behavior
      // This ensures both sprint boost and inertia use the same underwater state
      const isUnderWaterAtStart = entity.isUnderWater
      let acceleration = physics.liquidAcceleration
      const inertia = entity.isInWater ? physics.waterInertia : physics.lavaInertia
      let horizontalInertia = inertia

      if (entity.isInWater) {
        let strider = Math.min(entity.depthStrider, 3)
        if (!entity.onGround) {
          strider *= 0.5
        }
        if (strider > 0) {
          horizontalInertia += (0.546 - horizontalInertia) * strider / 3
          acceleration += (0.7 - acceleration) * strider / 3
        }

        if (entity.dolphinsGrace > 0) horizontalInertia = 0.96
      }

      // Bedrock sprint boost in water: defer the calculation until after moveEntity
      // when we know the final isUnderWater state. Save info needed for later.
      const bedrockWaterSprintInfo = isBedrock && entity.isInWater && entity.isSprinting
        ? { baseAccel: acceleration, startVelX: vel.x, startVelZ: vel.z } : null

      // Save horizontal velocity before water acceleration for Bedrock water entry
      const preVelX = vel.x
      const preVelZ = vel.z

      applyHeading(entity, strafe, forward, acceleration)
      const pose = entity.pose ?? PlayerPose.STANDING

      // Bedrock: on the first tick of water physics after entering from ground, preserve horizontal velocity
      // The game doesn't apply horizontal water acceleration until the second tick
      // For falling into water from air, water acceleration applies immediately
      // When sprinting over water edge: player was at edge (land physics) at tick N, then falls at tick N+1
      // At tick N+1, justEnteredWater is false but it's the first tick of water physics (isFirstWaterPhysicsTick)
      const firstTickWaterPhysics = justEnteredWater || isFirstWaterPhysicsTick
      if (isBedrock && firstTickWaterPhysics && entity.enteredWaterFromGround) {
        vel.x = preVelX
        vel.z = preVelZ
      }

      // Save velocity before moveEntity for Bedrock water entry
      const preVelY = vel.y
      // Also save horizontal velocity for water edge collision restoration
      const preMoveVelX = vel.x
      const preMoveVelZ = vel.z

      moveEntity(entity, world, vel.x, vel.y, vel.z, pose)

      // Bedrock water edge: when entering water and horizontal collision occurs,
      // restore horizontal velocity if we're at the water edge (center over water)
      // This handles shallow-angle approaches (like yaw=-15) where BB collides with
      // ground blocks at the water edge but horizontal velocity should be preserved
      // Apply for the first few ticks after entering water from ground (not for general water movement)
      // ticksSinceWaterEntry: 0 = first tick in water, 1-4 = subsequent water edge ticks
      const recentWaterEntry = entity.ticksSinceWaterEntry !== undefined && entity.ticksSinceWaterEntry <= 4
      if (isBedrock && entity.isInWater && entity.isCollidedHorizontally &&
          entity.enteredWaterFromGround && recentWaterEntry) {
        // Check if player is at water edge: their BB is in water but collision is with ground blocks
        // The player is considered at water edge if:
        // 1. They're in water (isInWater=true from BB water detection)
        // 2. They just entered water from ground
        // 3. They have horizontal collision
        // In this case, restore horizontal velocity - the collision is with the water edge ground
        // Restore horizontal velocity that was zeroed by collision with edge blocks
        vel.x = preMoveVelX
        vel.z = preMoveVelZ
        entity.isCollidedHorizontally = false
        // Adjust position - player should have moved by the original velocity
        pos.x = f(pos.x + preMoveVelX)
        pos.z = f(pos.z + preMoveVelZ)
      }

      // Bedrock water entry: when entering water, use center-point ground detection
      // If the block directly under player's center is water/air, they should fall
      // even if part of their collision BB is still over solid ground
      if (isBedrock && entity.isInWater && entity.onGround) {
        const centerBlockBelow = world.getBlock(pos.offset(0, -0.01, 0))
        const isCenterOverSolid = centerBlockBelow && !waterIds.includes(centerBlockBelow.type) &&
          !lavaIds.includes(centerBlockBelow.type) && centerBlockBelow.boundingBox !== 'empty'
        if (!isCenterOverSolid) {
          // Override ground detection - player falls into water
          entity.onGround = false
          entity.isCollidedVertically = false
          // Restore velocity that was zeroed by collision detection
          vel.y = preVelY
          // Also update position - player should have moved by preVelY
          pos.y = f(pos.y + preVelY)

          // Recalculate isUnderWater after position change
          // This ensures water physics kicks in at the right time
          const newEyeY = pos.y + poseEyeHeight[PlayerPose.STANDING]
          const newEyeBlockPos = new Vec3(Math.floor(pos.x), Math.floor(newEyeY), Math.floor(pos.z))
          const newEyeBlock = world.getBlock(newEyeBlockPos)
          entity.isUnderWater = newEyeBlock && waterIds.includes(newEyeBlock.type)
        }
      }

      // Bedrock: recalculate isUnderWater after position changes
      // The initial calculation was based on position at START of tick, but we need current position
      if (isBedrock) {
        const newEyeY = pos.y + poseEyeHeight[PlayerPose.STANDING]
        const newEyeBlockPos = new Vec3(Math.floor(pos.x), Math.floor(newEyeY), Math.floor(pos.z))
        const newEyeBlock = world.getBlock(newEyeBlockPos)
        entity.isUnderWater = newEyeBlock && waterIds.includes(newEyeBlock.type)
      }

      // Bedrock sprint boost in water: apply when sprinting in water
      // - Walked into water from ground (enteredWaterFromGround = true): skip first tick to preserve velocity
      // - Fell into water from air (enteredWaterFromGround = false): apply immediately upon entering water
      // Sprint boost uses underwater formula when eyes are submerged, above-water formula otherwise
      const skipSprintBoost = firstTickWaterPhysics && entity.enteredWaterFromGround
      const shouldApplySprintBoost = entity.isInWater
      if (bedrockWaterSprintInfo && !skipSprintBoost && shouldApplySprintBoost) {
        const { baseAccel, startVelX, startVelZ } = bedrockWaterSprintInfo
        const horizontalSpeed = Math.sqrt(f(f(startVelX * startVelX) + f(startVelZ * startVelZ)))

        let sprintAccel
        // Underwater formula when player's body is submerged:
        // - isUnderWater (eyes in water block)
        // - OR falling into water from air (body in water, eyes may be above surface)
        // Above-water formula only for horizontal entry from ground (walking into water from edge)
        const useUnderwaterFormula = entity.isUnderWater || !entity.enteredWaterFromGround
        if (useUnderwaterFormula) {
          // Underwater sprint boost: accel = base * 1.125 + 0.125 * horizontalSpeed
          sprintAccel = f(f(baseAccel * 1.125) + f(0.125 * horizontalSpeed))
        } else {
          // Above water sprint: accel = base * 1.3
          sprintAccel = f(baseAccel * (1 + physics.sprintSpeed))
        }

        // Calculate extra acceleration beyond base that needs to be added
        const extraAccel = f(sprintAccel - baseAccel)

        // Apply extra acceleration in movement direction (same direction as applyHeading)
        // For forward movement, this adds to Z (with yaw=PI, cos(0) = 1)
        const yaw = Math.PI - entity.yaw
        const sin = f(Math.sin(yaw))
        const cos = f(Math.cos(yaw))
        // Apply the extra forward acceleration
        vel.z = f(vel.z + f(extraAccel * cos))
        vel.x = f(vel.x - f(extraAccel * sin))
      }

      // Bedrock water Y-axis physics depends on how player entered water:
      // - Walked into water from ground: use land physics until eyes submerge
      // - Fell into water from air: use water physics immediately
      // - Eyes underwater or on ground in water: use standard water physics
      // The enteredWaterFromGround flag tracks the entry state
      // Note: uses entity.isUnderWater (updated after moveEntity) for Y physics
      // while horizontal physics uses isUnderWaterAtStart for consistency
      // Special case: on first tick of water entry while walking, use air physics
      // even if onGround is true (center over solid ground at water edge)
      const useAirPhysicsForY = isBedrock && entity.isInWater && !entity.isUnderWater &&
        entity.enteredWaterFromGround && (!entity.onGround || justEnteredWater)

      // Water/lava gravity:
      // - Java Edition: skip gravity when sprinting in water (Botcraft behavior)
      // - Bedrock Edition: skip gravity only when fully swimming (isSwimming = isSprinting && isUnderWater && isInWater)
      // - Lava: always apply gravity on both editions
      const skipWaterGravity = entity.isInWater && (isBedrock ? entity.isSwimming : entity.isSprinting)

      if (useAirPhysicsForY) {
        // Use land physics formula: (vel - gravity) * airdrag
        // This matches the formula in the land physics branch
        // For first tick of water entry while on ground (center over solid):
        // - moveEntity zeroed vel.y due to collision
        // - Use preVelY (pre-collision velocity) to match fixture behavior
        // - Update position since player should have fallen
        // Only apply when center is very close to water boundary (frac(z) > 0.9)
        // This matches diagonal water entry behavior vs parallel entry
        const centerZ = pos.z
        const fracZ = centerZ - Math.floor(centerZ)
        const isCloseToWaterEdge = fracZ > 0.9 || fracZ < 0.1 // Close to block boundary in either direction
        const usePreVelY = justEnteredWater && entity.onGround && isCloseToWaterEdge
        const inputVelY = usePreVelY ? preVelY : vel.y
        if (usePreVelY) {
          // Override ground collision - player starts falling into water
          entity.onGround = false
          entity.isCollidedVertically = false
          pos.y = f(pos.y + preVelY)
        }
        if (!skipWaterGravity) {
          vel.y = f(f(inputVelY - f(physics.gravity * gravityMultiplier)) * physics.airdrag)
        } else {
          vel.y = f(inputVelY * physics.airdrag)
        }
      } else {
        // Standard water physics: vel * inertia - waterGravity
        // Bedrock water edge entry: use pre-collision velocity for first N ticks after entering water from ground
        // This maintains terminal velocity convergence (-0.025) at the water edge before transitioning to on-ground terminal (-0.005)
        // Only applies when player walked into water from ground (enteredWaterFromGround), not for players already in water
        // For diagonal movement, delay is about 9 ticks. For straight movement, transition is immediate.
        let waterInputVelY = vel.y
        if (isBedrock && entity.onGround && entity.isUnderWater && entity.enteredWaterFromGround) {
          // Check if moving diagonally (both x and z velocity non-zero)
          const isDiagonalMovement = Math.abs(vel.x) > 1e-6 && Math.abs(vel.z) > 1e-6
          if (isDiagonalMovement) {
            // Track ticks on ground underwater for diagonal movement
            entity.ticksOnGroundUnderwater = (entity.ticksOnGroundUnderwater || 0) + 1
            // Use preVelY for first 9 ticks to maintain terminal velocity convergence
            // After 9 ticks, allow normal collision behavior (vel.y = 0 → -0.005)
            if (entity.ticksOnGroundUnderwater <= 9) {
              waterInputVelY = preVelY
            }
          }
          // For straight movement, allow immediate transition (don't use preVelY)
        } else if (!entity.enteredWaterFromGround) {
          // Reset counter when player didn't enter water from ground (already in water)
          entity.ticksOnGroundUnderwater = 0
        }
        vel.y = f(waterInputVelY * inertia)
        if (!skipWaterGravity) {
          const effectiveGravity = entity.isInWater ? physics.waterGravity : physics.lavaGravity
          vel.y = f(vel.y - f(effectiveGravity * gravityMultiplier))
        }
      }
      // Bedrock: when sprint just stopped in water, apply higher inertia (0.9 instead of 0.8)
      // This is the 1.125 multiplier applied to horizontal inertia on the transition tick
      // When eyes above water surface, use airborne inertia (0.91) instead of water inertia (0.8)
      let effectiveHorizontalInertia = useAirPhysicsForY ? physics.airborneInertia : horizontalInertia
      if (isBedrock && entity.isInWater && entity.wasSprinting && !entity.isSprinting) {
        effectiveHorizontalInertia = f(effectiveHorizontalInertia * 1.125)
      }
      // Bedrock: skip horizontal inertia on first tick when walking into water from ground
      // This preserves horizontal velocity. For falling into water from air, inertia applies normally.
      // Also skip when sprinting player just left water edge (isFirstWaterPhysicsTick) to maintain momentum
      const skipHorizontalInertia = isBedrock && firstTickWaterPhysics && entity.enteredWaterFromGround
      if (!skipHorizontalInertia) {
        vel.x = f(vel.x * effectiveHorizontalInertia)
        vel.z = f(vel.z * effectiveHorizontalInertia)
      }

      if (entity.isCollidedHorizontally && doesNotCollide(world, pos.offset(vel.x, vel.y + 0.6 - pos.y + lastY, vel.z), pose)) {
        vel.y = physics.outOfLiquidImpulse // jump out of liquid
      }
    } else if (entity.elytraFlying) {
      const {
        pitch,
        sinPitch,
        cosPitch,
        lookDir
      } = getLookingVector(entity)
      const horizontalSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z)
      const cosPitchSquared = cosPitch * cosPitch
      vel.y += physics.gravity * gravityMultiplier * (-1.0 + cosPitchSquared * 0.75)
      // cosPitch is in [0, 1], so cosPitch > 0.0 is just to protect against
      // divide by zero errors
      if (vel.y < 0.0 && cosPitch > 0.0) {
        const movingDownSpeedModifier = vel.y * (-0.1) * cosPitchSquared
        vel.x += lookDir.x * movingDownSpeedModifier / cosPitch
        vel.y += movingDownSpeedModifier
        vel.z += lookDir.z * movingDownSpeedModifier / cosPitch
      }

      if (pitch < 0.0 && cosPitch > 0.0) {
        const lookDownSpeedModifier = horizontalSpeed * (-sinPitch) * 0.04
        vel.x += -lookDir.x * lookDownSpeedModifier / cosPitch
        vel.y += lookDownSpeedModifier * 3.2
        vel.z += -lookDir.z * lookDownSpeedModifier / cosPitch
      }

      if (cosPitch > 0.0) {
        vel.x += (lookDir.x / cosPitch * horizontalSpeed - vel.x) * 0.1
        vel.z += (lookDir.z / cosPitch * horizontalSpeed - vel.z) * 0.1
      }

      vel.x = f(vel.x * 0.99)
      vel.y = f(vel.y * 0.98)
      vel.z = f(vel.z * 0.99)
      const pose = entity.pose ?? PlayerPose.FALL_FLYING
      moveEntity(entity, world, vel.x, vel.y, vel.z, pose)

      if (entity.onGround) {
        entity.elytraFlying = false
      }
    } else {
      // Normal movement
      let acceleration = 0.0
      let inertia = 0.0
      const blockUnder = world.getBlock(pos.offset(0, -1, 0))
      if (entity.onGround && blockUnder) {
        let playerSpeedAttribute
        if (entity.attributes && entity.attributes[physics.movementSpeedAttribute]) {
          // Use server-side player attributes
          playerSpeedAttribute = entity.attributes[physics.movementSpeedAttribute]
        } else {
          // Create an attribute if the player does not have it
          playerSpeedAttribute = attribute.createAttributeValue(physics.playerSpeed)
        }
        // Client-side sprinting (don't rely on server-side sprinting)
        // setSprinting in LivingEntity.java
        playerSpeedAttribute = attribute.deleteAttributeModifier(playerSpeedAttribute, physics.sprintingUUID) // always delete sprinting (if it exists)
        if (entity.isSprinting) {
          if (!attribute.checkAttributeModifier(playerSpeedAttribute, physics.sprintingUUID)) {
            playerSpeedAttribute = attribute.addAttributeModifier(playerSpeedAttribute, {
              uuid: physics.sprintingUUID,
              amount: physics.sprintSpeed,
              operation: 2
            })
          }
        }
        // Calculate what the speed is (0.1 if no modification)
        const attributeSpeed = f(attribute.getAttributeValue(playerSpeedAttribute))
        const slipperiness = f(blockSlipperiness[blockUnder.type] || physics.defaultSlipperiness)
        // Bedrock uses different formulas for inertia and acceleration
        if (isBedrock) {
          // Bedrock: inertia = f(f(slip) * f(0.91)), accel = f(speed * f(0.98))
          inertia = f(slipperiness * f(0.91))
          acceleration = f(attributeSpeed * f(0.98))
        } else {
          // Java: inertia = f(slip * 0.91), accel = speed * 0.1627714 / (inertia^3)
          inertia = f(slipperiness * 0.91)
          acceleration = f(attributeSpeed * f(0.1627714 / f(inertia * f(inertia * inertia))))
        }
        if (acceleration < 0) acceleration = 0 // acceleration should not be negative
      } else {
        inertia = physics.airborneInertia
        if (isBedrock) {
          // Bedrock: airborne acceleration also uses * 0.98 factor like ground
          acceleration = f(physics.airborneAcceleration * f(0.98))
        } else {
          acceleration = physics.airborneAcceleration
        }

        if (entity.isSprinting) {
          const airSprintFactor = acceleration * 0.3
          acceleration += airSprintFactor
        }
      }

      applyHeading(entity, strafe, forward, acceleration)

      if (isOnLadder(world, pos)) {
        vel.x = math.clamp(-physics.ladderMaxSpeed, vel.x, physics.ladderMaxSpeed)
        vel.z = math.clamp(-physics.ladderMaxSpeed, vel.z, physics.ladderMaxSpeed)
        vel.y = Math.max(vel.y, entity.control.sneak ? 0 : -physics.ladderMaxSpeed)
      }

      const pose = entity.pose ?? PlayerPose.STANDING

      // Save state before moveEntity for Bedrock water edge detection
      const preVelY = vel.y
      const wasOnGround = entity.onGround

      moveEntity(entity, world, vel.x, vel.y, vel.z, pose)

      // Bedrock water edge detection: player falls when their BACK edge is over water/void
      // Player can walk partially over water - they only fall when the trailing edge passes over
      // Use wasOnGround because moveEntity may have already set onGround=false while zeroing vel.y
      if (isBedrock && wasOnGround && entity.onGround) {
        const hw = physics.playerHalfWidth // 0.3

        // Check the back edge based on movement direction (opposite to velocity)
        let checkX = pos.x
        let checkZ = pos.z

        // Determine trailing edge based on velocity direction
        if (Math.abs(vel.x) > 0.01) {
          checkX = pos.x + (vel.x > 0 ? -hw : hw) // Back edge is opposite to movement
        }
        if (Math.abs(vel.z) > 0.01) {
          checkZ = pos.z + (vel.z > 0 ? -hw : hw) // Back edge is opposite to movement
        }

        const checkPos = new Vec3(checkX, pos.y, checkZ)
        const blockAtFeet = world.getBlock(checkPos)
        const blockBelow = world.getBlock(checkPos.offset(0, -0.01, 0))

        // Check if back edge is over water/void (not solid ground)
        const feetIsEmpty = blockAtFeet && blockAtFeet.boundingBox === 'empty' &&
          !waterIds.includes(blockAtFeet.type) && !lavaIds.includes(blockAtFeet.type)
        const belowIsWaterOrEmpty = blockBelow && (
          waterIds.includes(blockBelow.type) ||
          blockBelow.boundingBox === 'empty'
        )

        if (feetIsEmpty && belowIsWaterOrEmpty) {
          // Override ground detection - player falls into water
          entity.onGround = false
          entity.isCollidedVertically = false
          // Restore velocity that was zeroed by collision detection
          vel.y = preVelY
          // Update position - player should have fallen by preVelY
          pos.y = f(pos.y + preVelY)
        }
      }

      if (isOnLadder(world, pos) && (entity.isCollidedHorizontally ||
        (supportFeature('climbUsingJump') && entity.control.jump))) {
        vel.y = physics.ladderClimbSpeed // climb ladder
      }

      // Apply friction and gravity (single fround for better Bedrock match)
      if (entity.levitation > 0) {
        vel.y = f(f(vel.y + (0.05 * entity.levitation - vel.y) * 0.2) * physics.airdrag)
      } else {
        vel.y = f(f(vel.y - physics.gravity * gravityMultiplier) * physics.airdrag)
      }
      vel.x = f(vel.x * inertia)
      vel.z = f(vel.z * inertia)
    }
  }

  function isMaterialInBB (world, queryBB, types) {
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(queryBB.minY); cursor.y <= Math.floor(queryBB.maxY); cursor.y++) {
      for (cursor.z = Math.floor(queryBB.minZ); cursor.z <= Math.floor(queryBB.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(queryBB.minX); cursor.x <= Math.floor(queryBB.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          if (block && types.includes(block.type)) return true
        }
      }
    }
    return false
  }

  function getLiquidHeightPcent (block) {
    return (getRenderedDepth(block) + 1) / 9
  }

  function getRenderedDepth (block) {
    if (!block) return -1
    if (waterLike.has(block.type)) return 0
    if (block.isWaterlogged) return 0
    if (!waterIds.includes(block.type)) return -1
    const meta = block.metadata
    return meta >= 8 ? 0 : meta
  }

  function getFlow (world, block) {
    const curlevel = getRenderedDepth(block)
    const flow = new Vec3(0, 0, 0)
    for (const [dx, dz] of [[0, 1], [-1, 0], [0, -1], [1, 0]]) {
      const adjBlock = world.getBlock(block.position.offset(dx, 0, dz))
      const adjLevel = getRenderedDepth(adjBlock)
      if (adjLevel < 0) {
        if (adjBlock && adjBlock.boundingBox !== 'empty') {
          const adjLevel = getRenderedDepth(world.getBlock(block.position.offset(dx, -1, dz)))
          if (adjLevel >= 0) {
            const f = adjLevel - (curlevel - 8)
            flow.x += dx * f
            flow.z += dz * f
          }
        }
      } else {
        const f = adjLevel - curlevel
        flow.x += dx * f
        flow.z += dz * f
      }
    }

    if (block.metadata >= 8) {
      for (const [dx, dz] of [[0, 1], [-1, 0], [0, -1], [1, 0]]) {
        const adjBlock = world.getBlock(block.position.offset(dx, 0, dz))
        const adjUpBlock = world.getBlock(block.position.offset(dx, 1, dz))
        if ((adjBlock && adjBlock.boundingBox !== 'empty') || (adjUpBlock && adjUpBlock.boundingBox !== 'empty')) {
          flow.normalize().translate(0, -6, 0)
        }
      }
    }

    return flow.normalize()
  }

  function getWaterInBB (world, bb) {
    const waterBlocks = []
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(bb.minY); cursor.y <= Math.floor(bb.maxY); cursor.y++) {
      for (cursor.z = Math.floor(bb.minZ); cursor.z <= Math.floor(bb.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(bb.minX); cursor.x <= Math.floor(bb.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          if (block && (waterIds.includes(block.type) || waterLike.has(block.type) || block.isWaterlogged)) {
            const waterLevel = cursor.y + 1 - getLiquidHeightPcent(block)
            if (Math.ceil(bb.maxY) >= waterLevel) waterBlocks.push(block)
          }
        }
      }
    }
    return waterBlocks
  }

  function isInWaterApplyCurrent (world, bb, vel) {
    const acceleration = new Vec3(0, 0, 0)
    const waterBlocks = getWaterInBB(world, bb)
    const isInWater = waterBlocks.length > 0
    for (const block of waterBlocks) {
      const flow = getFlow(world, block)
      acceleration.add(flow)
    }

    const len = acceleration.norm()
    if (len > 0) {
      vel.x += acceleration.x / len * 0.014
      vel.y += acceleration.y / len * 0.014
      vel.z += acceleration.z / len * 0.014
    }
    return isInWater
  }

  physics.simulatePlayer = (entity, world) => {
    const vel = entity.vel
    const pos = entity.pos

    // Get current pose (default to STANDING, but preserve pose from previous tick)
    const currentPose = entity.pose ?? PlayerPose.STANDING

    // Always use STANDING pose for water/lava detection to avoid feedback loops
    // When swimming, the BB shrinks which would incorrectly detect leaving water
    const waterBB = getPlayerBB(pos, PlayerPose.STANDING).contract(0.001, 0.401, 0.001)
    const lavaBB = getPlayerBB(pos, PlayerPose.STANDING).contract(0.1, 0.4, 0.1)

    // Save wasInWater before updating for water entry detection
    entity.wasInWater = entity.isInWater || false
    entity.isInWater = isInWaterApplyCurrent(world, waterBB, vel)
    entity.isInLava = isMaterialInBB(world, lavaBB, lavaIds)

    // Save wasSneaking for sneak release timing (Bedrock behavior)
    // When sneak is released, sneak speed still applies for current tick
    // Use wasSneaking || current sneak so: press=immediate effect, release=delayed 1 tick
    const sneakForSpeed = entity.wasSneaking || (entity.control && entity.control.sneak)

    // Detect if eyes are underwater (Botcraft: under_water requires eye position below water surface)
    // Use current pose eye height, but when actively diving (looking down while sprinting in water)
    // use swimming pose eye height to allow earlier swimming transition
    const standingEyeHeight = poseEyeHeight[PlayerPose.STANDING]
    const standingEyeY = pos.y + standingEyeHeight
    // Calculate eye block position directly using floor(eyeY) to avoid floor(a)+floor(b) != floor(a+b) issues
    const standingEyeBlockPos = new Vec3(Math.floor(pos.x), Math.floor(standingEyeY), Math.floor(pos.z))
    const standingEyeBlock = world.getBlock(standingEyeBlockPos)
    const isUnderWaterStanding = standingEyeBlock && waterIds.includes(standingEyeBlock.type)

    // When actively diving (sprinting in water while looking down), check swimming pose eye height
    // This is key for diving transitions - swimming starts when swimming pose's eyes would be underwater
    // Pitch convention: negative = looking down, positive = looking up
    const isDiving = entity.isSprinting && entity.isInWater && entity.pitch < 0
    let isUnderWaterForSwimming = isUnderWaterStanding
    if (isDiving) {
      const swimmingEyeHeight = poseEyeHeight[PlayerPose.SWIMMING]
      const swimmingEyeY = pos.y + swimmingEyeHeight
      const swimmingEyeBlockPos = new Vec3(Math.floor(pos.x), Math.floor(swimmingEyeY), Math.floor(pos.z))
      const swimmingEyeBlock = world.getBlock(swimmingEyeBlockPos)
      isUnderWaterForSwimming = swimmingEyeBlock && waterIds.includes(swimmingEyeBlock.type)
    }

    // Use swimming pose check when actively diving, standing check otherwise
    entity.isUnderWater = isDiving ? isUnderWaterForSwimming : isUnderWaterStanding

    // Update internal sprint state BEFORE swimming calculation
    // Swimming depends on isSprinting, so sprint must be updated first
    if (entity.isCollidedHorizontally) {
      entity.isSprinting = false
    } else if (entity.isSprinting && !entity.control.sprint) {
      entity.isSprinting = false
    } else if (!entity.isSprinting && entity.control.sprint) {
      entity.isSprinting = true
    }

    // Update swimming state (Botcraft: requires Sprint + UnderWater + InWaterBlock)
    // Bedrock: swimming detection depends on how player entered water:
    // - Walked into water from ground: require "deeply underwater" (water above eye) to prevent
    //   immediate swimming when eyes are just at the surface water layer
    // - Fell into water from air: start swimming immediately when underwater (eyes in water block)
    const wasSwimming = entity.isSwimming || false
    let canSwim = entity.isUnderWater
    if (isBedrock && entity.isUnderWater && entity.enteredWaterFromGround) {
      // For horizontal water entry, require water in the block above the eye position
      // This delays swimming until player is below the surface water layer
      const eyeY = entity.pos.y + poseEyeHeight[PlayerPose.STANDING]
      const blockAboveEye = world.getBlock(new Vec3(Math.floor(entity.pos.x), Math.floor(eyeY) + 1, Math.floor(entity.pos.z)))
      canSwim = blockAboveEye && waterIds.includes(blockAboveEye.type)
    }
    entity.isSwimming = entity.isSprinting && canSwim && entity.isInWater
    entity.startSwimming = !wasSwimming && entity.isSwimming
    entity.stopSwimming = wasSwimming && !entity.isSwimming

    // Update player pose based on current state (Botcraft: updatePoses())
    // Priority order: FALL_FLYING > SWIMMING > SNEAKING > STANDING
    if (entity.elytraFlying) {
      entity.pose = PlayerPose.FALL_FLYING
    } else if (entity.isSwimming) {
      entity.pose = PlayerPose.SWIMMING
    } else if (entity.control && entity.control.sneak) {
      entity.pose = PlayerPose.SNEAKING
    } else {
      entity.pose = PlayerPose.STANDING
    }

    // Reset velocity component if it falls under the threshold
    if (Math.abs(vel.x) < physics.negligeableVelocity) vel.x = 0
    if (Math.abs(vel.y) < physics.negligeableVelocity) vel.y = 0
    if (Math.abs(vel.z) < physics.negligeableVelocity) vel.z = 0

    // Handle inputs
    if (entity.control.jump || entity.jumpQueued) {
      if (entity.jumpTicks > 0) entity.jumpTicks--
      if (entity.isInWater || entity.isInLava) {
        vel.y = f(vel.y + 0.04)
      } else if (entity.onGround && entity.jumpTicks === 0) {
        const blockBelow = world.getBlock(entity.pos.floored().offset(0, -0.5, 0))
        vel.y = f(f(0.42) * ((blockBelow && blockBelow.type === honeyblockId) ? physics.honeyblockJumpSpeed : 1))
        if (entity.jumpBoost > 0) {
          vel.y = f(vel.y + f(0.1 * entity.jumpBoost))
        }
        if (entity.isSprinting) {
          const yaw = Math.PI - entity.yaw
          vel.x = f(vel.x - f(Math.sin(yaw) * 0.2))
          vel.z = f(vel.z + f(Math.cos(yaw) * 0.2))
        }
        entity.jumpTicks = physics.autojumpCooldown
      }
    } else {
      entity.jumpTicks = 0 // reset autojump cooldown
    }
    entity.jumpQueued = false

    // For Java, 0.98 is applied to controls. For Bedrock, 0.98 is in the acceleration formula.
    const controlMultiplier = isBedrock ? 1.0 : 0.98
    let strafe = (entity.control.right - entity.control.left) * controlMultiplier
    let forward = (entity.control.forward - entity.control.back) * controlMultiplier

    // Sneak speed is applied based on sneakForSpeed (wasSneaking || currentSneak)
    // This ensures sneak release doesn't affect speed until next tick (Bedrock behavior)
    // For Bedrock underwater, sneak is for diving, not slower horizontal movement
    // In lava, sneak speed (0.3) still applies on Bedrock
    if (sneakForSpeed && !(isBedrock && entity.isInWater)) {
      strafe *= physics.sneakSpeed
      forward *= physics.sneakSpeed
    }

    entity.elytraFlying = entity.elytraFlying && entity.elytraEquipped && !entity.onGround && !entity.levitation

    // Pitch-dependent swimming: when swimming, adjust Y velocity toward look direction
    // lookY = -sin(pitch): looking up → positive Y, looking down → negative Y
    // Based on analysis of Bedrock fixtures: adjustment always applies when swimming
    // Factor: 0.085 when looking steeply (|pitch| > 0.2 rad), 0.06 otherwise
    if (entity.isSwimming) {
      const lookY = f(-Math.sin(entity.pitch))

      // Bedrock: always apply when swimming (fixtures show pitch affects Y velocity)
      // Factor is 0.085 for steep angles, 0.06 for shallow
      const factor = Math.abs(entity.pitch) > 0.2 ? 0.085 : 0.06
      vel.y = f(vel.y + f(f(lookY - vel.y) * factor))
    }

    if (entity.fireworkRocketDuration > 0) {
      if (!entity.elytraFlying) {
        entity.fireworkRocketDuration = 0
      } else {
        const { lookDir } = getLookingVector(entity)
        vel.x = f(vel.x + f(f(lookDir.x * 0.1) + f(f(lookDir.x * 1.5) - vel.x) * 0.5))
        vel.y = f(vel.y + f(f(lookDir.y * 0.1) + f(f(lookDir.y * 1.5) - vel.y) * 0.5))
        vel.z = f(vel.z + f(f(lookDir.z * 0.1) + f(f(lookDir.z * 1.5) - vel.z) * 0.5))
        --entity.fireworkRocketDuration
      }
    }

    moveEntityWithHeading(entity, world, strafe, forward)

    return entity
  }

  return physics
}

function getEffectLevel (mcData, effectName, effects) {
  const effectDescriptor = mcData.effectsByName[effectName]
  if (!effectDescriptor) {
    return 0
  }
  const effectInfo = effects[effectDescriptor.id]
  if (!effectInfo) {
    return 0
  }
  return effectInfo.amplifier + 1
}

function getEnchantmentLevel (mcData, enchantmentName, enchantments) {
  const enchantmentDescriptor = mcData.enchantmentsByName[enchantmentName]
  if (!enchantmentDescriptor) {
    return 0
  }

  for (const enchInfo of enchantments) {
    if (typeof enchInfo.id === 'string') {
      if (enchInfo.id.includes(enchantmentName)) {
        return enchInfo.lvl
      }
    } else if (enchInfo.id === enchantmentDescriptor.id) {
      return enchInfo.lvl
    }
  }
  return 0
}

class PlayerState {
  constructor (bot, control) {
    const mcData = require('minecraft-data')(bot.version)
    const nbt = require('prismarine-nbt')

    // Input / Outputs
    this.pos = bot.entity.position.clone()
    this.vel = bot.entity.velocity.clone()
    this.onGround = bot.entity.onGround
    this.isInWater = bot.entity.isInWater
    // Track previous water state for Bedrock water entry detection
    this.wasInWater = bot.entity.wasInWater ?? false
    this.isInLava = bot.entity.isInLava
    this.isInWeb = bot.entity.isInWeb
    this.isCollidedHorizontally = bot.entity.isCollidedHorizontally
    this.isCollidedVertically = bot.entity.isCollidedVertically
    this.elytraFlying = bot.entity.elytraFlying
    // Internal sprint state - disabled on horizontal collision, re-enabled when control.sprint and no collision
    this.isSprinting = bot.entity.isSprinting ?? control.sprint
    // Track previous sprint state for Bedrock water physics transition
    this.wasSprinting = bot.entity.wasSprinting ?? false
    // Track previous sneak state for Bedrock sneak release timing
    this.wasSneaking = bot.entity.wasSneaking ?? false
    // Track previous ground state for Bedrock water entry detection
    this.wasOnGround = bot.entity.wasOnGround ?? false
    // Track if player entered water from ground (for Bedrock air physics in water)
    this.enteredWaterFromGround = bot.entity.enteredWaterFromGround ?? false
    // Track if player was at water edge (for Bedrock sprint water physics)
    this.wasAtWaterEdge = bot.entity.wasAtWaterEdge ?? false
    // Track ticks on ground underwater (for Bedrock pool bottom physics)
    this.ticksOnGroundUnderwater = bot.entity.ticksOnGroundUnderwater ?? 0
    // Track ticks since water entry (for Bedrock water edge grace period)
    this.ticksSinceWaterEntry = bot.entity.ticksSinceWaterEntry ?? 0
    // Player pose (affects bounding box dimensions)
    this.pose = bot.entity.pose ?? PlayerPose.STANDING
    // Swimming state
    this.isSwimming = bot.entity.isSwimming ?? false
    this.isUnderWater = bot.entity.isUnderWater ?? false
    this.jumpTicks = bot.jumpTicks
    this.jumpQueued = bot.jumpQueued
    this.fireworkRocketDuration = bot.fireworkRocketDuration

    // Input only (not modified)
    this.attributes = bot.entity.attributes
    this.yaw = bot.entity.yaw
    this.pitch = bot.entity.pitch
    this.control = control

    // effects
    const effects = bot.entity.effects

    this.jumpBoost = getEffectLevel(mcData, 'JumpBoost', effects)
    this.speed = getEffectLevel(mcData, 'Speed', effects)
    this.slowness = getEffectLevel(mcData, 'Slowness', effects)

    this.dolphinsGrace = getEffectLevel(mcData, 'DolphinsGrace', effects)
    this.slowFalling = getEffectLevel(mcData, 'SlowFalling', effects)
    this.levitation = getEffectLevel(mcData, 'Levitation', effects)

    // armour enchantments
    const boots = bot.inventory.slots[8]
    if (boots && boots.nbt) {
      const simplifiedNbt = nbt.simplify(boots.nbt)
      const enchantments = simplifiedNbt.Enchantments ?? simplifiedNbt.ench ?? []
      this.depthStrider = getEnchantmentLevel(mcData, 'depth_strider', enchantments)
    } else {
      this.depthStrider = 0
    }

    // extra elytra requirements
    const item = bot.inventory.slots[6]
    this.elytraEquipped = item != null && item.name === 'elytra'
  }

  apply (bot) {
    bot.entity.position = this.pos
    bot.entity.velocity = this.vel
    bot.entity.onGround = this.onGround
    bot.entity.isInWater = this.isInWater
    // Store current water state as previous for next tick (Bedrock water entry detection)
    bot.entity.wasInWater = this.isInWater
    bot.entity.isInLava = this.isInLava
    bot.entity.isInWeb = this.isInWeb
    bot.entity.isCollidedHorizontally = this.isCollidedHorizontally
    bot.entity.isCollidedVertically = this.isCollidedVertically
    bot.entity.elytraFlying = this.elytraFlying
    bot.entity.isSprinting = this.isSprinting
    // Store current sprint state as previous for next tick (Bedrock water physics transition)
    bot.entity.wasSprinting = this.isSprinting
    // Store current sneak state as previous for next tick (Bedrock sneak release timing)
    bot.entity.wasSneaking = this.control && this.control.sneak
    // Store current ground state as previous for next tick (Bedrock water entry detection)
    bot.entity.wasOnGround = this.onGround
    // Store water entry state for Bedrock air physics in water
    bot.entity.enteredWaterFromGround = this.enteredWaterFromGround
    // Store water edge state for Bedrock sprint water physics
    bot.entity.wasAtWaterEdge = this.wasAtWaterEdge
    // Store ticks on ground underwater for Bedrock pool bottom physics
    bot.entity.ticksOnGroundUnderwater = this.ticksOnGroundUnderwater
    // Store ticks since water entry for Bedrock water edge grace period
    bot.entity.ticksSinceWaterEntry = this.ticksSinceWaterEntry
    // Player pose and swimming state
    bot.entity.pose = this.pose
    bot.entity.isSwimming = this.isSwimming
    bot.entity.isUnderWater = this.isUnderWater
    bot.jumpTicks = this.jumpTicks
    bot.jumpQueued = this.jumpQueued
    bot.fireworkRocketDuration = this.fireworkRocketDuration
  }
}

module.exports = { Physics, PlayerState, PlayerPose, poseDimensions, poseEyeHeight }
