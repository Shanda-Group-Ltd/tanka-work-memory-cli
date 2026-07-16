/** Tanka upload-target form: pick the environment (dev/test/uat/prod), enter
 *  the token, edit the device name, and view the device ID. Both token + env
 *  persist to credentials.json; deviceName persists to config.json. Saving
 *  always verifies the token against the chosen environment first. */
import { Box, Text } from 'ink';
import type React from 'react';
import { useState } from 'react';

import { HintBar, ScreenFrame } from '../components/ScreenFrame';
import { Spinner } from '../components/Spinner';
import { TextInput } from '../components/TextInput';
import { applyTextKey } from '../components/textEditing';
import {
  DEFAULT_SCIENCE_DIR,
  DEFAULT_TANKA_ENV,
  type TankaEnv,
} from '../config/config';
import { useConfig } from '../hooks/useConfig';
import { useScreenInput } from '../hooks/useScreenInput';
import { theme } from '../theme';
import {
  availableEnvs,
  resolveBaseUrl,
  testConnection,
} from '../upload/tanka-client';

const ENV_ROW = 0;
const TOKEN_ROW = 1;
const DEVICE_NAME_ROW = 2;
const DEVICE_ID_ROW = 3;
const SCIENCE_DIR_ROW = 4;
const ACTION_ROW = 5;
const ROW_COUNT = 6;

type TestState = { status: 'idle' | 'testing' | 'error'; message?: string };

export function TankaConfigScreen({
  onSaved,
  onCancel,
  onBack,
  onCancelAll,
  wizardLabel,
}: {
  onSaved: () => void;
  onCancel: () => void;
  onBack?: () => void;
  onCancelAll?: () => void;
  wizardLabel?: string;
}): React.ReactElement {
  const { config, credentials, setConfig, setCredentials } = useConfig();

  const envs = availableEnvs();

  const initialEnv: TankaEnv =
    envs.length === 0
      ? DEFAULT_TANKA_ENV
      : credentials?.env && envs.includes(credentials.env)
        ? credentials.env
        : envs.includes(DEFAULT_TANKA_ENV)
          ? DEFAULT_TANKA_ENV
          : envs[0]!;

  const [token, setToken] = useState<string>(credentials?.token ?? '');
  const [env, setEnv] = useState<TankaEnv>(initialEnv);
  const [deviceName, setDeviceName] = useState<string>(config.deviceName ?? '');
  const [scienceDir, setScienceDir] = useState<string>(
    config.scienceDir ?? DEFAULT_SCIENCE_DIR,
  );
  const [focus, setFocus] = useState(0);
  const [reveal, setReveal] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });

  const testAndSave = (): void => {
    if (test.status === 'testing') return;
    if (!token.trim()) {
      setTest({ status: 'error', message: 'token is required' });
      return;
    }
    setTest({ status: 'testing' });
    testConnection(token.trim(), env).then(
      () => {
        setCredentials({ token: token.trim(), env });
        const next = { ...config };
        let changed = false;
        if (deviceName.trim() && deviceName.trim() !== config.deviceName) {
          next.deviceName = deviceName.trim();
          changed = true;
        }
        const sd = scienceDir.trim();
        if (sd && sd !== (config.scienceDir ?? DEFAULT_SCIENCE_DIR)) {
          next.scienceDir = sd;
          changed = true;
        } else if (!sd && config.scienceDir !== undefined) {
          // Field cleared → drop the override so the default applies again
          // (otherwise the old custom path silently survives behind the
          // default-looking placeholder).
          delete next.scienceDir;
          changed = true;
        }
        if (changed) setConfig(next);
        onSaved();
      },
      (e: unknown) =>
        setTest({
          status: 'error',
          message: e instanceof Error ? e.message : String(e),
        }),
    );
  };

  useScreenInput((input, key) => {
    if (key.escape) {
      (onBack ?? onCancel)();
      return;
    }
    if (key.ctrl && (input === 'r' || input === 'R')) {
      setReveal((r) => !r);
      return;
    }
    if ((key.tab && key.shift) || key.upArrow) {
      setFocus((f) => (f + ROW_COUNT - 1) % ROW_COUNT);
      return;
    }
    if (key.tab || key.downArrow) {
      setFocus((f) => (f + 1) % ROW_COUNT);
      return;
    }
    // env row
    if (focus === ENV_ROW) {
      if (envs.length > 1) {
        const i = envs.indexOf(env);
        if (key.leftArrow) {
          setEnv(envs[(i + envs.length - 1) % envs.length]!);
          setTest({ status: 'idle' });
        } else if (key.rightArrow || input === ' ') {
          setEnv(envs[(i + 1) % envs.length]!);
          setTest({ status: 'idle' });
        }
      }
      if (input === 'C' && onCancelAll) {
        onCancelAll();
      } else if (key.return) {
        testAndSave();
      }
      return;
    }
    // device ID row — read-only, only cancel/enter work
    if (focus === DEVICE_ID_ROW) {
      if (input === 'C' && onCancelAll) {
        onCancelAll();
        return;
      }
      if (key.return) testAndSave();
      return;
    }
    // action row
    if (focus === ACTION_ROW) {
      if (input === 'C' && onCancelAll) {
        onCancelAll();
        return;
      }
      if (key.return) testAndSave();
      return;
    }
    // token row — every printable char goes into the token
    if (focus === TOKEN_ROW) {
      if (key.return) {
        testAndSave();
        return;
      }
      setToken((s) => applyTextKey(s, input, key));
      setTest({ status: 'idle' });
      return;
    }
    // device name row — editable text field
    if (focus === DEVICE_NAME_ROW) {
      if (key.return) {
        testAndSave();
        return;
      }
      setDeviceName((s) => applyTextKey(s, input, key));
      return;
    }
    // claude-science dir row — editable text field
    if (focus === SCIENCE_DIR_ROW) {
      if (key.return) {
        testAndSave();
        return;
      }
      setScienceDir((s) => applyTextKey(s, input, key));
      return;
    }
  });

  if (envs.length === 0) {
    return (
      <ScreenFrame title="Tanka settings" subtitle="configuration error">
        <Text color={theme.err}>
          No API environments configured. Set at least TANKA_API_URL_PROD.
        </Text>
      </ScreenFrame>
    );
  }

  return (
    <ScreenFrame
      title="Tanka settings"
      subtitle={wizardLabel ?? 'Tanka upload target'}
      footer={
        <HintBar
          hints={[
            ['↑↓/tab', 'move'],
            ...(envs.length > 1
              ? ([['←→', 'environment']] as Array<[string, string]>)
              : []),
            ['enter', 'test & save'],
            ['^r', reveal ? 'hide token' : 'show token'],
            ['esc', onBack ? 'back' : 'cancel'],
            ...(onCancelAll
              ? ([['C', 'cancel all']] as Array<[string, string]>)
              : []),
          ]}
        />
      }
    >
      <Box flexDirection="column">
        {/* environment selector */}
        <Box marginBottom={1}>
          <Text color={focus === ENV_ROW ? theme.brand : theme.dim}>
            {focus === ENV_ROW ? '❯ ' : '  '}
          </Text>
          <Text color={focus === ENV_ROW ? theme.text : theme.dim}>
            {'target'.padEnd(16)}
          </Text>
          <Text>{'◀ '}</Text>
          <Text color={theme.accent}>{env}</Text>
          <Text>{' ▶'}</Text>
          <Text color={theme.dim}>{`   ${resolveBaseUrl(env)}`}</Text>
        </Box>

        {/* token */}
        <Box>
          <Text color={focus === TOKEN_ROW ? theme.brand : theme.dim}>
            {focus === TOKEN_ROW ? '❯ ' : '  '}
          </Text>
          <Text color={focus === TOKEN_ROW ? theme.text : theme.dim}>
            {'token'.padEnd(16)}
          </Text>
          <TextInput
            value={token}
            focused={focus === TOKEN_ROW}
            mask={!reveal}
            placeholder="—"
          />
        </Box>

        {/* device name — editable */}
        <Box marginTop={1}>
          <Text color={focus === DEVICE_NAME_ROW ? theme.brand : theme.dim}>
            {focus === DEVICE_NAME_ROW ? '❯ ' : '  '}
          </Text>
          <Text color={focus === DEVICE_NAME_ROW ? theme.text : theme.dim}>
            {'device name'.padEnd(16)}
          </Text>
          <TextInput
            value={deviceName}
            focused={focus === DEVICE_NAME_ROW}
            placeholder="—"
          />
        </Box>

        {/* device ID — read-only */}
        <Box>
          <Text color={focus === DEVICE_ID_ROW ? theme.brand : theme.dim}>
            {focus === DEVICE_ID_ROW ? '❯ ' : '  '}
          </Text>
          <Text color={focus === DEVICE_ID_ROW ? theme.text : theme.dim}>
            {'device id'.padEnd(16)}
          </Text>
          <Text color={theme.dim}>
            {config.deviceId ?? '(auto-generated on first run)'}
          </Text>
        </Box>

        {/* claude-science data dir — editable */}
        <Box marginTop={1}>
          <Text color={focus === SCIENCE_DIR_ROW ? theme.brand : theme.dim}>
            {focus === SCIENCE_DIR_ROW ? '❯ ' : '  '}
          </Text>
          <Text color={focus === SCIENCE_DIR_ROW ? theme.text : theme.dim}>
            {'claude science'.padEnd(16)}
          </Text>
          <TextInput
            value={scienceDir}
            focused={focus === SCIENCE_DIR_ROW}
            placeholder={DEFAULT_SCIENCE_DIR}
          />
        </Box>

        {/* test & save */}
        <Box marginTop={1}>
          <Text color={focus === ACTION_ROW ? theme.brand : theme.dim}>
            {focus === ACTION_ROW ? '❯ ' : '  '}
          </Text>
          <Text
            color={focus === ACTION_ROW ? theme.text : theme.dim}
            bold={focus === ACTION_ROW}
          >
            Test and Save
          </Text>
          <Text>{'   '}</Text>
          {test.status === 'testing' ? <Spinner label="testing…" /> : null}
          {test.status === 'error' ? (
            <Text color={theme.err}>{`✗ ${test.message}`}</Text>
          ) : null}
        </Box>
      </Box>
    </ScreenFrame>
  );
}
