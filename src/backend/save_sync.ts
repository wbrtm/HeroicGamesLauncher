import { Runner } from 'common/types'
import { GOGCloudSavesLocation, SaveFolderVariable } from 'common/types/gog'
import { getWinePath, setupWineEnvVars } from './launcher'
import { runLegendaryCommand, LegendaryLibrary } from './legendary/library'
import { GOGLibrary } from './gog/library'
import {
  logDebug,
  LogPrefix,
  logInfo,
  logError,
  logWarning
} from './logger/logger'
import { getGame, getShellPath } from './utils'
import { existsSync, realpathSync } from 'graceful-fs'
import { app } from 'electron'

async function getDefaultSavePath(
  appName: string,
  runner: Runner,
  alreadyDefinedGogSaves: GOGCloudSavesLocation[]
): Promise<string | GOGCloudSavesLocation[]> {
  switch (runner) {
    case 'legendary':
      return getDefaultLegendarySavePath(appName)
    case 'gog':
      return getDefaultGogSavePaths(appName, alreadyDefinedGogSaves)
  }
}

async function getDefaultLegendarySavePath(appName: string): Promise<string> {
  const game = getGame(appName, 'legendary')
  const { save_path } = game.getGameInfo()
  if (save_path) {
    logDebug(['Got default save path from GameInfo:', save_path], {
      prefix: LogPrefix.Legendary
    })
    return save_path
  }
  // If Legendary doesn't have a save folder set yet, run it & accept its generated path
  // TODO: This whole interaction is a little weird, maybe ask Rodney if he's willing to
  //       make this a little smoother to automate
  logInfo(['Computing default save path for', appName], {
    prefix: LogPrefix.Legendary
  })
  // NOTE: The easiest way I've found to just compute the path is by running the sync
  //       and disabling both save up- and download
  let gotSavePath = false
  await runLegendaryCommand(
    ['sync-saves', appName, '--skip-upload', '--skip-download'],
    {
      logMessagePrefix: 'Getting default save path',
      env: setupWineEnvVars(await game.getSettings()),
      onOutput: (output, child) => {
        if (output.includes('Is this correct?')) {
          gotSavePath = true
          child.stdin?.cork()
          child.stdin?.write('y\n')
          child.stdin?.uncork()
        } else if (
          output.includes(
            'Path contains unprocessed variables, please enter the correct path manually'
          )
        ) {
          child.kill()
          logError(
            [
              'Legendary was unable to compute the default save path of',
              appName
            ],
            { prefix: LogPrefix.Legendary }
          )
        }
      }
    }
  )
  if (!gotSavePath) {
    logError(['Unable to compute default save path for', appName], {
      prefix: LogPrefix.Legendary
    })
    return ''
  }
  // If the save path was computed successfully, Legendary will have saved
  // this path in `installed.json` (so the GameInfo)
  // `= ''` here just in case Legendary failed to write the file
  const { save_path: new_save_path = '' } = LegendaryLibrary.get().getGameInfo(
    appName,
    true
  )!
  logInfo(['Computed save path:', new_save_path], {
    prefix: LogPrefix.Legendary
  })
  return new_save_path
}

async function getDefaultGogSavePaths(
  appName: string,
  alreadyDefinedGogSaves: GOGCloudSavesLocation[]
): Promise<GOGCloudSavesLocation[]> {
  const game = getGame(appName, 'gog')
  const {
    gog_save_location,
    install: { platform: installed_platform, install_path }
  } = game.getGameInfo()
  if (!gog_save_location || !install_path) {
    logError([
      'gog_save_location/install_path undefined. gog_save_location = ',
      gog_save_location,
      'install_path = ',
      install_path
    ])
    return []
  }

  // If no save locations are defined, assume the default
  if (!gog_save_location.length) {
    const clientId = GOGLibrary.get().readInfoFile(appName)?.clientId
    gog_save_location.push({
      name: '__default',
      location:
        installed_platform === 'windows'
          ? `%LocalAppData%/GOG.com/Galaxy/Applications/${clientId}/Storage/Shared/Files`
          : `$HOME/Library/Application Support/GOG.com/Galaxy/Applications/${clientId}/Storage`
    })
  }

  const gogVariableMap: Record<SaveFolderVariable, string> = {
    INSTALL: install_path,
    SAVED_GAMES: '%USERPROFILE%/Saved Games',
    APPLICATION_DATA_LOCAL: '%LOCALAPPDATA%',
    APPLICATION_DATA_LOCAL_LOW: '%APPDATA%\\..\\LocalLow',
    APPLICATION_DATA_ROAMING: '%APPDATA',
    APPLICATION_SUPPORT: '$HOME/Library/Application Support',
    DOCUMENTS: game.isNative()
      ? app.getPath('documents')
      : '%USERPROFILE%\\Documents'
  }
  const resolvedLocations: GOGCloudSavesLocation[] = []
  for (const location of gog_save_location) {
    logDebug([
      'Working on location',
      location.name,
      'with path',
      location.location
    ])
    // If a location with the same name already has a path set,
    // skip doing all this work
    const potAlreadyDefinedLocation = alreadyDefinedGogSaves.find(
      ({ name }) => name === location.name
    )

    if (potAlreadyDefinedLocation?.location.length) {
      logDebug([
        'Location is already defined, pushing it onto resolvedLocations. Pre-defined path:',
        potAlreadyDefinedLocation.location
      ])
      resolvedLocations.push(potAlreadyDefinedLocation)
      continue
    }

    // Get all GOG-defined variables out of the path & resolve them
    const matches = location.location.matchAll(/<\?(\w+)\?>/g)
    let locationWithVariablesRemoved = location.location
    for (const match of matches) {
      const matchedText = match[0]
      const variableName = match[1]
      if (!gogVariableMap[variableName]) {
        logWarning(
          [
            'Unknown save path variable:',
            `${variableName},`,
            'inserting variable itself into save path.',
            'User will have to manually correct the path'
          ],
          {
            prefix: LogPrefix.Gog
          }
        )
      }
      locationWithVariablesRemoved = locationWithVariablesRemoved.replace(
        matchedText,
        gogVariableMap[variableName] ?? variableName
      )
    }

    logDebug([
      'Got this path after GOG variable expansion:',
      locationWithVariablesRemoved
    ])

    // Path now contains no more GOG-defined variables, but might
    // still contain Windows (%NAME%) or Unix ($NAME) ones
    let absolutePath: string
    if (!game.isNative()) {
      absolutePath = await getWinePath({
        path: locationWithVariablesRemoved,
        game
      })
      // Wine already resolves symlinks and ./.. for us,
      // so no need to run `realpathSync` here
    } else {
      absolutePath = await getShellPath(locationWithVariablesRemoved)
      if (existsSync(absolutePath)) {
        try {
          absolutePath = realpathSync(absolutePath)
        } catch {
          logWarning(['Failed to run `realpath` on', `"${absolutePath}"`], {
            prefix: LogPrefix.Gog
          })
        }
      }
    }

    logDebug([
      'Got this path after running winepath/getShellPath:',
      `"${absolutePath}".`,
      'Pushing that onto resolvedLocations'
    ])

    resolvedLocations.push({
      name: location.name,
      location: absolutePath
    })
  }

  return resolvedLocations
}

export { getDefaultSavePath }
