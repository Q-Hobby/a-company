import type { ImportReceipt, PortableImportBundle } from "@acompany/contracts";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Button,
  FlatList,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { continuationInput, createArchiveRequestGate } from "../lib/portable-import";

type Archive = { receipt: ImportReceipt; bundle: PortableImportBundle };
type ArchiveItem = { kind: "session" | "project" | "skill"; id: string; label: string };

export default function Imports() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const [reads] = useState(createArchiveRequestGate);
  const [continues] = useState(createArchiveRequestGate);
  const [receipts, setReceipts] = useState<ImportReceipt[]>([]);
  const [archive, setArchive] = useState<Archive | null>(null);
  const [item, setItem] = useState<ArchiveItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokens = mobileTokens();

  const refresh = useCallback(async () => {
    const request = reads.begin();
    if (!request) return;
    continues.invalidate();
    setContinuing(false);
    setArchive(null);
    setItem(null);
    setError(null);
    setLoading(true);
    try {
      const next = await rpc<ImportReceipt[]>("imports/list", {}, { signal: request.signal });
      if (request.isCurrent()) setReceipts(next);
    } catch {
      if (request.isCurrent()) setError(t("Could not load imported archives. Try again."));
    } finally {
      if (request.isCurrent()) setLoading(false);
      request.finish();
    }
  }, [reads, continues, t]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      return () => {
        reads.invalidate();
        continues.invalidate();
      };
    }, [refresh, reads, continues]),
  );

  async function openArchive(id: string) {
    const request = reads.begin();
    if (!request) return;
    continues.invalidate();
    setContinuing(false);
    setArchive(null);
    setItem(null);
    setError(null);
    setLoading(true);
    try {
      // Ordinary archive reads are redacted by the shared API. No raw export on mobile.
      const next = await rpc<Archive>("imports/get", { id }, { signal: request.signal });
      if (request.isCurrent()) setArchive(next);
    } catch {
      if (request.isCurrent()) setError(t("Could not load imported archives. Try again."));
    } finally {
      if (request.isCurrent()) setLoading(false);
      request.finish();
    }
  }

  function selectItem(next: ArchiveItem | null) {
    continues.invalidate();
    setContinuing(false);
    setError(null);
    setItem(next);
  }

  async function continueSession() {
    if (!archive || item?.kind !== "session") return;
    const input = continuationInput(archive.receipt.id, archive.bundle, item.id);
    if (!input) return;
    const request = continues.begin(true);
    if (!request) return;
    setContinuing(true);
    setError(null);
    let openedThread = false;
    try {
      const result = await rpc<{ botId: string }>("imports/continue", input, {
        signal: request.signal,
      });
      if (request.isCurrent()) {
        router.push({ pathname: "/thread", params: { botId: result.botId } });
        openedThread = true;
      }
    } catch {
      // Never display server error messages: they may contain source data or secrets.
      if (request.isCurrent()) setError(t("Could not continue this session. Try again."));
    } finally {
      // Hold the successful claim until blur so a second tap cannot create another bot.
      if (!openedThread) {
        if (request.isCurrent()) setContinuing(false);
        request.finish();
      }
    }
  }

  function showHelp() {
    Alert.alert(
      t("Import data"),
      t(
        "Open desktop/web on the source computer to scan and import. Imported archives appear here. Mobile cannot scan that computer or connect to its local import helper. Sensitive data is excluded by default and requires your choice for each import on desktop/web. Mobile shows redacted archives only and does not offer raw sensitive exports. Imported skills remain inactive.",
      ),
    );
  }

  const session =
    item?.kind === "session"
      ? archive?.bundle.sessions.find((entry) => entry.id === item.id)
      : undefined;
  const inspected =
    item?.kind === "project"
      ? archive?.bundle.projects.find((entry) => entry.id === item.id)
      : item?.kind === "skill"
        ? archive?.bundle.skills.find((entry) => entry.id === item.id)
        : undefined;
  const sections: { title: string; data: ArchiveItem[] }[] = archive
    ? [
        {
          title: t("Imported sessions"),
          data: archive.bundle.sessions.map((entry) => ({
            kind: "session" as const,
            id: entry.id,
            label: entry.title || t("Untitled session"),
          })),
        },
        {
          title: t("Imported projects"),
          data: archive.bundle.projects.map((entry) => ({
            kind: "project" as const,
            id: entry.id,
            label: entry.name,
          })),
        },
        {
          title: t("Archived skills (inactive)"),
          data: archive.bundle.skills.map((entry) => ({
            kind: "skill" as const,
            id: entry.id,
            label: entry.name,
          })),
        },
      ].filter((section) => section.data.length > 0)
    : [];

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <Stack.Screen options={{ title: t("Import data") }} />
      <View style={styles.toolbar}>
        <Button color={tokens.primary} title={t("How to import")} onPress={showHelp} />
        {item ? (
          <Button
            color={tokens.primary}
            title={t("Back to archive")}
            onPress={() => selectItem(null)}
          />
        ) : (
          <Button
            color={tokens.primary}
            title={archive ? t("All archives") : t("Refresh")}
            disabled={continuing}
            onPress={() => void refresh()}
          />
        )}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {loading ? (
        <ActivityIndicator color={tokens.primary} />
      ) : session ? (
        <>
          <View style={styles.toolbar}>
            <Text style={styles.title}>{session.title || t("Untitled session")}</Text>
            <Button
              color={tokens.primary}
              title={continuing ? t("Continuing…") : t("Continue work")}
              disabled={continuing}
              onPress={() => void continueSession()}
            />
          </View>
          <FlatList
            data={session.messages}
            keyExtractor={(_, index) => String(index)}
            contentContainerStyle={styles.content}
            ListEmptyComponent={<Text style={styles.detail}>{t("No messages")}</Text>}
            renderItem={({ item: message }) => (
              <View style={styles.card}>
                <Text style={styles.detail}>{message.role}</Text>
                <Text selectable style={styles.text}>
                  {message.content}
                </Text>
              </View>
            )}
          />
        </>
      ) : inspected ? (
        <FlatList
          data={inspected.files}
          keyExtractor={(_, index) => String(index)}
          contentContainerStyle={styles.content}
          ListHeaderComponent={<Text style={styles.title}>{inspected.name}</Text>}
          ListEmptyComponent={<Text style={styles.detail}>{t("No files")}</Text>}
          renderItem={({ item: file }) => (
            <Text selectable style={styles.text}>
              {file.path}
            </Text>
          )}
        />
      ) : archive ? (
        <SectionList
          sections={sections}
          keyExtractor={(entry) => `${entry.kind}:${entry.id}`}
          contentContainerStyle={styles.content}
          ListEmptyComponent={<Text style={styles.detail}>{t("This archive is empty.")}</Text>}
          renderSectionHeader={({ section }) => <Text style={styles.heading}>{section.title}</Text>}
          renderItem={({ item: entry }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => selectItem(entry)}
              style={({ pressed }) => [styles.card, pressed && styles.pressed]}
            >
              <Text style={styles.text}>{entry.label}</Text>
            </Pressable>
          )}
        />
      ) : (
        <FlatList
          data={receipts}
          keyExtractor={(receipt) => receipt.id}
          contentContainerStyle={styles.content}
          ListEmptyComponent={
            !error ? <Text style={styles.detail}>{t("No imported archives yet.")}</Text> : null
          }
          renderItem={({ item: receipt }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => void openArchive(receipt.id)}
              style={({ pressed }) => [styles.card, pressed && styles.pressed]}
            >
              <Text style={styles.text}>
                {new Date(receipt.importedAt).toLocaleString(dateLocaleForUi(locale))}
              </Text>
              <Text style={styles.detail}>
                {t("{projects} projects · {sessions} sessions · {skills} skills", {
                  projects: receipt.projectCount,
                  sessions: receipt.sessionCount,
                  skills: receipt.skillCount,
                })}
              </Text>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    toolbar: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
    content: { padding: 20, gap: 12 },
    card: { padding: 16, borderRadius: 14, backgroundColor: native.fill, gap: 8, marginBottom: 8 },
    title: { fontSize: 18, fontWeight: "600", color: native.label },
    heading: {
      fontSize: 16,
      fontWeight: "600",
      color: native.label,
      paddingVertical: 12,
      backgroundColor: native.page,
    },
    text: { fontSize: 16, color: native.label },
    detail: { fontSize: 14, color: native.secondaryLabel },
    error: { padding: 16, color: tokens.destructive },
    pressed: { opacity: 0.7 },
  });
}
