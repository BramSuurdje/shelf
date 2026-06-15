import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  Bars3BottomLeftIcon,
  ClockIcon,
  ClipboardDocumentIcon,
  Cog6ToothIcon,
  DocumentIcon,
  FolderIcon,
  GlobeAltIcon,
  LinkIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  ShareIcon,
  Squares2X2Icon,
  TableCellsIcon,
  TrashIcon,
  UserPlusIcon,
  UserCircleIcon,
  UsersIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"

import { apiFetch, authFetch, type ShelfNode } from "@/api/client"
import { usePreferences } from "@/stores/preferences"
import { useUploadStore } from "@/upload/store"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Progress } from "@workspace/ui/components/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

type Section =
  | "my-shelf"
  | "shared"
  | "public-links"
  | "recent"
  | "trash"
  | "admin"
  | "profile"

const folderFormSchema = z.object({
  name: z.string().min(1).max(255),
})

type FolderForm = z.infer<typeof folderFormSchema>

interface CurrentUser {
  user: {
    id: string
    name: string
    email: string
    image?: string | null
    username?: string | null
    role?: "owner" | "admin" | "user"
    preferences?: Record<string, unknown>
  }
}

interface PublicLinkRow {
  id: string
  nodeId: string
  token?: string
  status: string
  expiresAt: string | null
  downloadCount: number
  maxDownloads: number | null
  createdAt: string
}

interface InviteRow {
  id: string
  email: string
  role: "admin" | "user"
  acceptedAt: string | null
  revokedAt: string | null
  expiresAt: string
  createdAt: string
}

interface NodeShareRow {
  nodeId: string
  userId: string
  username: string
  name: string
  email: string
  permission: "viewer" | "editor"
  createdAt: string
}

interface AdminUserRow {
  id: string
  name: string
  email: string
  username: string
  role: string
  disabledAt: string | null
  usedBytes: number | null
  reservedBytes: number | null
  trashBytes: number | null
}

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
})

const signupSchema = loginSchema.extend({
  name: z.string().min(1),
  username: z.string().min(3).max(32).regex(/^[a-z0-9_]{3,32}$/),
  inviteToken: z.string().optional(),
})

const setupFormSchema = z.object({
  appName: z.string().min(1),
  publicAppUrl: z.url(),
  name: z.string().min(1),
  email: z.email(),
  username: z.string().min(3).max(32).regex(/^[a-z0-9_]{3,32}$/),
  password: z.string().min(10),
  s3Endpoint: z.url(),
  s3Region: z.string().min(1),
  s3Bucket: z.string().min(1),
  s3AccessKeyId: z.string().min(1),
  s3SecretAccessKey: z.string().min(1),
  s3ForcePathStyle: z.boolean(),
  s3PublicBaseUrl: z.url().optional().or(z.literal("")),
  defaultUserQuotaGb: z.coerce.number().positive(),
  globalQuotaGb: z.coerce.number().positive().optional(),
  registrationMode: z.enum(["invite_only", "open", "disabled"]),
  githubEnabled: z.boolean(),
  googleEnabled: z.boolean(),
  smtpEnabled: z.boolean(),
})

type LoginForm = z.infer<typeof loginSchema>
type SignupForm = z.infer<typeof signupSchema>
type SetupForm = z.infer<typeof setupFormSchema>
type SetupFormInput = z.input<typeof setupFormSchema>
type AdminSettingsForm = {
  registrationMode: "invite_only" | "open" | "disabled"
  defaultRole: "user" | "admin"
  defaultUserQuotaGb: number
  globalQuotaGb: number | ""
  publicLinksEnabled: boolean
  folderSharingEnabled: boolean
  defaultPublicLinkExpirationDays: number
  maxPublicLinkExpirationDays: number
  maxUploadMb: number
  emailVerificationRequired: boolean
  passwordMinLength: number
  sessionLifetimeDays: number
  trashRetentionDays: number
  pendingUploadExpirationMinutes: number
  thumbnailsEnabled: boolean
  githubEnabled: boolean
  googleEnabled: boolean
  smtpEnabled: boolean
}

type AdminStorageForm = {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  publicBaseUrl: string
}

type AdminSmtpForm = {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
  from: string
}

type AuthenticatedAppState = {
  section: Section
  parentId: string | null
  selectedNode: ShelfNode | null
  isDragging: boolean
  searchQuery: string
}

type AuthenticatedAppAction =
  | { type: "set-section"; section: Section }
  | { type: "open-folder"; parentId: string | null }
  | { type: "select-node"; node: ShelfNode | null }
  | { type: "set-dragging"; isDragging: boolean }
  | { type: "set-search"; searchQuery: string }
  | { type: "open-my-shelf-folder"; parentId: string }

const authenticatedAppInitialState: AuthenticatedAppState = {
  section: "my-shelf",
  parentId: null,
  selectedNode: null,
  isDragging: false,
  searchQuery: "",
}

function authenticatedAppReducer(
  state: AuthenticatedAppState,
  action: AuthenticatedAppAction
): AuthenticatedAppState {
  switch (action.type) {
    case "set-section":
      return { ...state, section: action.section }
    case "open-folder":
      return { ...state, parentId: action.parentId }
    case "select-node":
      return { ...state, selectedNode: action.node }
    case "set-dragging":
      return { ...state, isDragging: action.isDragging }
    case "set-search":
      return { ...state, searchQuery: action.searchQuery }
    case "open-my-shelf-folder":
      return { ...state, parentId: action.parentId, section: "my-shelf" }
  }
}

const navigation: Array<{
  id: Section
  label: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
}> = [
  { id: "my-shelf", label: "My Shelf", icon: FolderIcon },
  { id: "shared", label: "Shared with me", icon: UsersIcon },
  { id: "public-links", label: "Public links", icon: LinkIcon },
  { id: "recent", label: "Recent", icon: ClockIcon },
  { id: "trash", label: "Trash", icon: TrashIcon },
  { id: "admin", label: "Admin", icon: Cog6ToothIcon },
  { id: "profile", label: "Profile", icon: UserCircleIcon },
]

export function App() {
  const publicMatch = /^\/public\/([^/]+)$/.exec(window.location.pathname)
  return publicMatch ? <PublicLinkView token={publicMatch[1]} /> : <AuthenticatedApp />
}

function PublicLinkView({ token }: { token: string }) {
  const queryClient = useQueryClient()
  const [password, setPassword] = React.useState("")
  const [passwordSubmitted, setPasswordSubmitted] = React.useState(false)
  const {
    data: publicLinkData,
    error: publicLinkError,
  } = useQuery({
    queryKey: ["public-link", token, passwordSubmitted],
    queryFn: () =>
      apiFetch<{ node: ShelfNode; children: ShelfNode[] }>(`/public/${token}`, {
        headers: password ? { "x-public-link-password": password } : undefined,
      }),
    retry: false,
  })
  const downloadMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/v1/public/${token}/download`, {
        headers: password ? { "x-public-link-password": password } : undefined,
      })
      if (!response.ok) throw new Error("Download failed")
      const contentType = response.headers.get("content-type") ?? ""
      if (contentType.includes("application/json")) {
        const payload = (await response.json()) as { data?: { url?: string } }
        if (!payload.data?.url) throw new Error("Download URL missing")
        window.location.assign(payload.data.url)
        return
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `${publicLinkData?.node.name ?? "shelf-download"}.zip`
      link.click()
      URL.revokeObjectURL(url)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["public-link", token] }),
  })

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-md rounded-md border border-border p-5">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <GlobeAltIcon className="size-5" />
          </div>
          <div>
            <h1 className="font-heading text-lg font-semibold">Shared Shelf link</h1>
            <p className="text-sm text-muted-foreground">View or download shared content.</p>
          </div>
        </div>

        {publicLinkError ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              setPasswordSubmitted((value) => !value)
            }}
          >
            <TextInput
              label="Password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button className="w-full" type="submit">Unlock link</Button>
            <p className="text-sm text-destructive">{publicLinkError.message}</p>
          </form>
        ) : publicLinkData ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-md border border-border p-3">
              {publicLinkData.node.type === "folder" ? (
                <FolderIcon className="size-8 text-primary" />
              ) : (
                <DocumentIcon className="size-8 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <div className="truncate font-medium">{publicLinkData.node.name}</div>
                <div className="text-sm text-muted-foreground">
                  {publicLinkData.node.type}
                  {publicLinkData.node.type === "file"
                    ? `, ${formatBytes(publicLinkData.node.sizeBytes)}`
                    : ""}
                </div>
              </div>
            </div>
            {publicLinkData.node.type === "folder" && publicLinkData.children.length > 0 ? (
              <div className="max-h-64 overflow-auto rounded-md border border-border">
                {publicLinkData.children.map((child) => (
                  <div
                    key={child.id}
                    className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    {child.type === "folder" ? (
                      <FolderIcon className="size-4 text-primary" />
                    ) : (
                      <DocumentIcon className="size-4 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm">{child.name}</span>
                    {child.type === "file" ? (
                      <span className="text-xs text-muted-foreground">
                        {formatBytes(child.sizeBytes)}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            <Button
              className="w-full"
              onClick={() => downloadMutation.mutate()}
            >
              <ArrowDownTrayIcon className="size-4" />
              Download
            </Button>
            {downloadMutation.error ? (
              <p className="text-sm text-destructive">{downloadMutation.error.message}</p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Loading shared content.</p>
        )}
      </div>
    </div>
  )
}

function AuthenticatedApp() {
  const [state, dispatch] = React.useReducer(
    authenticatedAppReducer,
    authenticatedAppInitialState
  )
  const { section, parentId, selectedNode, isDragging, searchQuery } = state
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const folderInputRef = React.useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const { density, setDensity, viewMode, setViewMode } = usePreferences()
  const { tasks, addFiles, addFileGroups, retry, cancel } = useUploadStore()

  const {
    data: setupStatus,
    isLoading: setupStatusLoading,
    refetch: refetchSetupStatus,
  } = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => apiFetch<{ required: boolean; disabled: boolean }>("/setup/status"),
    retry: false,
  })

  const {
    data: currentUserData,
    refetch: refetchCurrentUser,
  } = useQuery({
    queryKey: ["current-user"],
    queryFn: () => apiFetch<CurrentUser>("/auth/current-user"),
    enabled: setupStatus?.required === false,
    retry: false,
  })

  const { data: nodesData } = useQuery({
    queryKey: ["nodes", parentId],
    queryFn: () =>
      apiFetch<{ nodes: ShelfNode[] }>(
        `/nodes${parentId ? `?parentId=${encodeURIComponent(parentId)}` : ""}`
      ),
    enabled: section === "my-shelf",
    retry: false,
  })

  const { data: searchData } = useQuery({
    queryKey: ["nodes-search", searchQuery],
    queryFn: () =>
      apiFetch<{ nodes: ShelfNode[] }>(
        `/nodes/search?q=${encodeURIComponent(searchQuery)}`
      ),
    enabled: searchQuery.trim().length > 0 && Boolean(currentUserData),
    retry: false,
  })

  const folderForm = useForm<FolderForm>({
    resolver: zodResolver(folderFormSchema),
    defaultValues: { name: "" },
  })

  const createFolderMutation = useMutation({
    mutationFn: (values: FolderForm) =>
      apiFetch("/nodes/folders", {
        method: "POST",
        body: JSON.stringify({
          mutationId: crypto.randomUUID(),
          parentId,
          name: values.name,
        }),
      }),
    onSuccess: async () => {
      folderForm.reset()
      await queryClient.invalidateQueries({ queryKey: ["nodes"] })
    },
  })

  const nodes = nodesData?.nodes ?? []
  const uploadProgress =
    tasks.length === 0
      ? 0
      : tasks.reduce((total, task) => total + task.progress, 0) / tasks.length

  React.useEffect(() => {
    const handleUploadComplete = () => {
      void queryClient.invalidateQueries({ queryKey: ["nodes"] })
      void queryClient.invalidateQueries({ queryKey: ["recent"] })
    }
    window.addEventListener("shelf:upload-complete", handleUploadComplete)
    return () => window.removeEventListener("shelf:upload-complete", handleUploadComplete)
  }, [queryClient])

  React.useEffect(() => {
    if (!folderInputRef.current) return
    const input = folderInputRef.current as HTMLInputElement & {
      webkitdirectory?: boolean
      directory?: boolean
    }
    input.webkitdirectory = true
    input.directory = true
  }, [])

  const uploadFolderFiles = React.useCallback(
    async (files: File[]) => {
      const folderIds = new Map<string, string | null>([["", parentId]])
      const filesByFolderId = new Map<string | null, File[]>()
      const topLevelFolders = new Set<string>()
      for (const file of files) {
        const relativePath =
          (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
        const pathParts = relativePath.split("/").filter(Boolean)
        if (pathParts.length > 1 && pathParts[0]) {
          topLevelFolders.add(pathParts[0])
        }
      }
      const toastLabel =
        topLevelFolders.size === 1
          ? (Array.from(topLevelFolders)[0] ?? "Folder")
          : `${files.length} files`

      for (const file of files) {
        const relativePath =
          (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
        const pathParts = relativePath.split("/").filter(Boolean)
        const folderParts = pathParts.slice(0, -1)
        let currentPath = ""

        for (const folderName of folderParts) {
          const nextPath = currentPath ? `${currentPath}/${folderName}` : folderName
          if (!folderIds.has(nextPath)) {
            const result = await apiFetch<{ nodeId: string }>("/nodes/folders", {
              method: "POST",
              body: JSON.stringify({
                mutationId: crypto.randomUUID(),
                parentId: folderIds.get(currentPath) ?? null,
                name: folderName,
              }),
            })
            folderIds.set(nextPath, result.nodeId)
          }
          currentPath = nextPath
        }

        const targetFolderId = folderIds.get(currentPath) ?? parentId
        filesByFolderId.set(targetFolderId, [
          ...(filesByFolderId.get(targetFolderId) ?? []),
          file,
        ])
      }

      addFileGroups(
        Array.from(filesByFolderId, ([targetFolderId, groupedFiles]) => ({
          files: groupedFiles,
          parentId: targetFolderId,
        })),
        { toastLabel }
      )
      await queryClient.invalidateQueries({ queryKey: ["nodes"] })
    },
    [addFileGroups, parentId, queryClient]
  )

  if (setupStatusLoading) {
    return <FullScreenMessage title="Shelf" message="Checking setup status" />
  }

  if (setupStatus?.required) {
    return <FirstRunSetup onComplete={() => void refetchSetupStatus()} />
  }

  if (!currentUserData) {
    return <AuthScreen onComplete={() => void refetchCurrentUser()} />
  }

  return (
    <AuthenticatedWorkspace
      addFiles={addFiles}
      cancel={cancel}
      createFolder={(values) => createFolderMutation.mutate(values)}
      currentUser={currentUserData.user}
      density={density}
      dispatch={dispatch}
      fileInputRef={fileInputRef}
      folderForm={folderForm}
      folderInputRef={folderInputRef}
      isDragging={isDragging}
      nodes={nodes}
      parentId={parentId}
      retry={retry}
      searchData={searchData}
      searchQuery={searchQuery}
      section={section}
      selectedNode={selectedNode}
      setDensity={setDensity}
      setViewMode={setViewMode}
      tasks={tasks}
      uploadFolderFiles={uploadFolderFiles}
      uploadProgress={uploadProgress}
      viewMode={viewMode}
    />
  )
}

function AuthenticatedWorkspace({
  addFiles,
  cancel,
  createFolder,
  currentUser,
  density,
  dispatch,
  fileInputRef,
  folderForm,
  folderInputRef,
  isDragging,
  nodes,
  parentId,
  retry,
  searchData,
  searchQuery,
  section,
  selectedNode,
  setDensity,
  setViewMode,
  tasks,
  uploadFolderFiles,
  uploadProgress,
  viewMode,
}: {
  addFiles: ReturnType<typeof useUploadStore.getState>["addFiles"]
  cancel: ReturnType<typeof useUploadStore.getState>["cancel"]
  createFolder: (values: FolderForm) => void
  currentUser: CurrentUser["user"]
  density: "comfortable" | "compact"
  dispatch: React.Dispatch<AuthenticatedAppAction>
  fileInputRef: React.RefObject<HTMLInputElement | null>
  folderForm: ReturnType<typeof useForm<FolderForm>>
  folderInputRef: React.RefObject<HTMLInputElement | null>
  isDragging: boolean
  nodes: ShelfNode[]
  parentId: string | null
  retry: ReturnType<typeof useUploadStore.getState>["retry"]
  searchData?: { nodes: ShelfNode[] }
  searchQuery: string
  section: Section
  selectedNode: ShelfNode | null
  setDensity: (density: "comfortable" | "compact") => void
  setViewMode: (viewMode: "table" | "grid") => void
  tasks: ReturnType<typeof useUploadStore.getState>["tasks"]
  uploadFolderFiles: (files: File[]) => Promise<void>
  uploadProgress: number
  viewMode: "table" | "grid"
}) {
  return (
    <div
      className="min-h-svh bg-background text-foreground"
      onDragOver={(event) => {
        event.preventDefault()
        dispatch({ type: "set-dragging", isDragging: true })
      }}
      onDragLeave={() => dispatch({ type: "set-dragging", isDragging: false })}
      onDrop={(event) => {
        event.preventDefault()
        dispatch({ type: "set-dragging", isDragging: false })
        void extractDroppedFiles(event.dataTransfer).then((files) =>
          uploadFolderFiles(files.length > 0 ? files : Array.from(event.dataTransfer.files))
        )
      }}
    >
      <div className="flex min-h-svh">
        <aside className="hidden w-64 shrink-0 border-r border-border bg-sidebar/70 px-3 py-4 lg:block">
          <div className="mb-6 flex items-center gap-2 px-2">
            <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <FolderIcon className="size-5" />
            </div>
            <div>
              <div className="font-heading text-base font-semibold">Shelf</div>
              <div className="text-xs text-muted-foreground">Self-hosted drive</div>
            </div>
          </div>

          <nav className="space-y-1">
            {navigation.map((item) => {
              const Icon = item.icon
              const active = item.id === section
              return (
                <button
                  key={item.id}
                  className={`flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition ${
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  }`}
                  onClick={() => dispatch({ type: "set-section", section: item.id })}
                  type="button"
                >
                  <Icon className="size-4" />
                  <span className="truncate">{item.label}</span>
                </button>
              )
            })}
          </nav>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            <Button
              aria-label="Open navigation"
              variant="ghost"
              size="icon-sm"
              className="lg:hidden"
            >
              <Bars3BottomLeftIcon className="size-5" />
            </Button>

            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-background px-3 py-2">
              <MagnifyingGlassIcon className="size-4 text-muted-foreground" />
              <input
                aria-label="Search files, folders, shares"
                value={searchQuery}
                onChange={(event) =>
                  dispatch({ type: "set-search", searchQuery: event.target.value })
                }
                className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                placeholder="Search files, folders, shares"
                type="search"
              />
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setDensity(density === "comfortable" ? "compact" : "comfortable")
              }
            >
              {density === "comfortable" ? "Compact" : "Comfortable"}
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Toggle view"
              onClick={() => setViewMode(viewMode === "table" ? "grid" : "table")}
              title="Toggle view"
            >
              {viewMode === "table" ? (
                <Squares2X2Icon className="size-4" />
              ) : (
                <TableCellsIcon className="size-4" />
              )}
            </Button>
          </header>

          <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px]">
            <section className="min-w-0 overflow-auto px-4 py-4">
              {searchQuery.trim().length > 0 ? (
                <NodeListPanel
                  emptyLabel="No search results"
                  nodes={searchData?.nodes ?? []}
                  onOpenFolder={(id) => dispatch({ type: "open-folder", parentId: id })}
                  onSelectNode={(node) => dispatch({ type: "select-node", node })}
                  selectedNode={selectedNode}
                  title="Search results"
                />
              ) : section === "my-shelf" ? (
                <FileBrowser
                  createFolder={createFolder}
                  density={density}
                  fileInputRef={fileInputRef}
                  folderForm={folderForm}
                  nodes={nodes}
                  onOpenFolder={(id) => dispatch({ type: "open-folder", parentId: id })}
                  onPickFolder={() => folderInputRef.current?.click()}
                  onPickFiles={() => fileInputRef.current?.click()}
                  onSelectNode={(node) => dispatch({ type: "select-node", node })}
                  parentId={parentId}
                  selectedNode={selectedNode}
                  viewMode={viewMode}
                />
              ) : (
                <SectionContent
                  currentUser={currentUser}
                  section={section}
                  onOpenFolder={(id) => {
                    dispatch({ type: "open-my-shelf-folder", parentId: id })
                  }}
                  onSelectNode={(node) => dispatch({ type: "select-node", node })}
                  selectedNode={selectedNode}
                />
              )}
            </section>

            <aside className="hidden border-l border-border bg-muted/25 xl:block">
              <DetailsPanel node={selectedNode} />
              <UploadDrawer
                cancel={cancel}
                progress={uploadProgress}
                retry={retry}
                tasks={tasks}
              />
            </aside>
          </div>
        </main>
      </div>

      <input
        aria-label="Upload files"
        ref={fileInputRef}
        className="hidden"
        multiple
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []), parentId)
          event.currentTarget.value = ""
        }}
        type="file"
      />

      <input
        aria-label="Upload folder"
        ref={folderInputRef}
        className="hidden"
        multiple
        onChange={(event) => {
          void uploadFolderFiles(Array.from(event.target.files ?? []))
          event.currentTarget.value = ""
        }}
        type="file"
      />

      {isDragging ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="rounded-md border border-dashed border-primary bg-background px-8 py-6 text-center">
            <ArrowDownTrayIcon className="mx-auto mb-3 size-8 text-primary" />
            <div className="font-medium">Drop files to upload</div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function FileBrowser({
  createFolder,
  density,
  fileInputRef,
  folderForm,
  nodes,
  onOpenFolder,
  onPickFolder,
  onPickFiles,
  onSelectNode,
  parentId,
  selectedNode,
  viewMode,
}: {
  createFolder: (values: FolderForm) => void
  density: "comfortable" | "compact"
  fileInputRef: React.RefObject<HTMLInputElement | null>
  folderForm: ReturnType<typeof useForm<FolderForm>>
  nodes: ShelfNode[]
  onOpenFolder: (id: string | null) => void
  onPickFolder: () => void
  onPickFiles: () => void
  onSelectNode: (node: ShelfNode) => void
  parentId: string | null
  selectedNode: ShelfNode | null
  viewMode: "table" | "grid"
}) {
  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold">My Shelf</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <button
              className="hover:text-foreground"
              onClick={() => onOpenFolder(null)}
              type="button"
            >
              Root
            </button>
            {parentId ? <span>/ Current folder</span> : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <form
            className="flex items-center gap-2"
            onSubmit={folderForm.handleSubmit((values) => createFolder(values))}
          >
            <Input
              className="w-44"
              placeholder="Folder name"
              {...folderForm.register("name")}
            />
            <Button size="sm" type="submit">
              <PlusIcon className="size-4" />
              Folder
            </Button>
          </form>
          <Button size="sm" onClick={onPickFiles}>
            <ArrowDownTrayIcon className="size-4" />
            Upload
          </Button>
          <Button size="sm" variant="outline" onClick={onPickFolder}>
            <FolderIcon className="size-4" />
            Folder upload
          </Button>
        </div>
      </div>

      {nodes.length === 0 ? (
        <div className="flex min-h-80 flex-col items-center justify-center rounded-md border border-dashed border-border text-center">
          <FolderIcon className="mb-3 size-10 text-muted-foreground" />
          <h2 className="font-heading text-lg font-semibold">No files here yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Create a folder or upload files to start building this shelf.
          </p>
          <Button className="mt-4" onClick={() => fileInputRef.current?.click()}>
            <ArrowDownTrayIcon className="size-4" />
            Upload files
          </Button>
        </div>
      ) : viewMode === "table" ? (
        <div className="overflow-hidden rounded-md border border-border">
          <Table className="table-fixed">
            <TableHeader className="bg-muted/60 text-xs uppercase text-muted-foreground">
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden w-28 sm:table-cell">Type</TableHead>
                <TableHead className="hidden w-32 md:table-cell">Size</TableHead>
                <TableHead className="hidden w-44 lg:table-cell">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {nodes.map((node) => (
                <NodeRow
                  density={density}
                  key={node.id}
                  node={node}
                  onOpenFolder={onOpenFolder}
                  onSelectNode={onSelectNode}
                  selected={selectedNode?.id === node.id}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {nodes.map((node) => (
            <button
              key={node.id}
              className={`min-w-0 rounded-md border p-3 text-left transition ${
                selectedNode?.id === node.id
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-muted/60"
              }`}
              onClick={() => {
                onSelectNode(node)
                if (node.type === "folder") onOpenFolder(node.id)
              }}
              type="button"
            >
              {node.type === "folder" ? (
                <FolderIcon className="mb-8 size-8 text-primary" />
              ) : (
                <DocumentIcon className="mb-8 size-8 text-muted-foreground" />
              )}
              <div className="truncate text-sm font-medium">{node.name}</div>
              <div className="mt-1 text-xs text-muted-foreground">{formatBytes(node.sizeBytes)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function NodeRow({
  density,
  node,
  onOpenFolder,
  onSelectNode,
  selected,
}: {
  density: "comfortable" | "compact"
  node: ShelfNode
  onOpenFolder: (id: string) => void
  onSelectNode: (node: ShelfNode) => void
  selected: boolean
}) {
  return (
    <TableRow
      className={`border-t border-border transition hover:bg-muted/50 ${
        selected ? "bg-primary/5" : ""
      }`}
    >
      <TableCell className={density === "compact" ? "px-3 py-2" : "px-3 py-3"}>
        <button
          className="flex min-w-0 items-center gap-2"
          onClick={() => {
            onSelectNode(node)
            if (node.type === "folder") onOpenFolder(node.id)
          }}
          type="button"
        >
          {node.type === "folder" ? (
            <FolderIcon className="size-5 shrink-0 text-primary" />
          ) : (
            <DocumentIcon className="size-5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-medium">{node.name}</span>
        </button>
      </TableCell>
      <TableCell className="hidden px-3 py-2 text-muted-foreground sm:table-cell">
        <Badge variant="outline">{node.type}</Badge>
      </TableCell>
      <TableCell className="hidden px-3 py-2 text-muted-foreground md:table-cell">
        {formatBytes(node.sizeBytes)}
      </TableCell>
      <TableCell className="hidden px-3 py-2 text-muted-foreground lg:table-cell">
        {new Date(node.updatedAt).toLocaleString()}
      </TableCell>
    </TableRow>
  )
}

function FullScreenMessage({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4 text-foreground">
      <div className="text-center">
        <FolderIcon className="mx-auto mb-3 size-10 text-primary" />
        <h1 className="font-heading text-2xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  )
}

function AuthScreen({ onComplete }: { onComplete: () => void }) {
  const queryClient = useQueryClient()
  const [mode, setMode] = React.useState<"login" | "signup">("login")
  const loginForm = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  })
  const signupForm = useForm<SignupForm>({
    resolver: zodResolver(signupSchema),
    defaultValues: { name: "", email: "", username: "", password: "", inviteToken: "" },
  })
  const loginMutation = useMutation({
    mutationFn: (values: LoginForm) => authFetch("/sign-in/email", values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["current-user"] })
      onComplete()
    },
  })
  const signupMutation = useMutation({
    mutationFn: (values: SignupForm) =>
      authFetch("/sign-up/email", { ...values, mutationId: crypto.randomUUID() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["current-user"] })
      onComplete()
    },
  })

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <FolderIcon className="mx-auto mb-3 size-9 text-primary" />
          <h1 className="font-heading text-2xl font-semibold">Shelf</h1>
        </div>
        <div className="mb-3 grid grid-cols-2 rounded-md border border-border p-1">
          <button
            className={`rounded px-3 py-2 text-sm ${mode === "login" ? "bg-muted" : ""}`}
            onClick={() => setMode("login")}
            type="button"
          >
            Sign in
          </button>
          <button
            className={`rounded px-3 py-2 text-sm ${mode === "signup" ? "bg-muted" : ""}`}
            onClick={() => setMode("signup")}
            type="button"
          >
            Sign up
          </button>
        </div>

        {mode === "login" ? (
          <form
            className="space-y-3"
            onSubmit={loginForm.handleSubmit((values) => loginMutation.mutate(values))}
          >
            <TextInput label="Email" type="email" {...loginForm.register("email")} />
            <TextInput label="Password" type="password" {...loginForm.register("password")} />
            <Button className="w-full" type="submit">Sign in</Button>
            {loginMutation.error ? (
              <p className="text-sm text-destructive">{loginMutation.error.message}</p>
            ) : null}
          </form>
        ) : (
          <form
            className="space-y-3"
            onSubmit={signupForm.handleSubmit((values) => signupMutation.mutate(values))}
          >
            <TextInput label="Name" {...signupForm.register("name")} />
            <TextInput label="Email" type="email" {...signupForm.register("email")} />
            <TextInput label="Username" {...signupForm.register("username")} />
            <TextInput label="Invite token" {...signupForm.register("inviteToken")} />
            <TextInput label="Password" type="password" {...signupForm.register("password")} />
            <Button className="w-full" type="submit">Create account</Button>
            {signupMutation.error ? (
              <p className="text-sm text-destructive">{signupMutation.error.message}</p>
            ) : null}
          </form>
        )}
      </div>
    </div>
  )
}

function FirstRunSetup({ onComplete }: { onComplete: () => void }) {
  const queryClient = useQueryClient()
  const [verifiedStorageSignature, setVerifiedStorageSignature] = React.useState<string | null>(null)
  const form = useForm<SetupFormInput, unknown, SetupForm>({
    resolver: zodResolver(setupFormSchema),
    defaultValues: {
      appName: "Shelf",
      publicAppUrl: window.location.origin,
      name: "",
      email: "",
      username: "",
      password: "",
      s3Endpoint: "https://storage.railway.app",
      s3Region: "auto",
      s3Bucket: "",
      s3AccessKeyId: "",
      s3SecretAccessKey: "",
      s3ForcePathStyle: false,
      s3PublicBaseUrl: "",
      defaultUserQuotaGb: 10,
      registrationMode: "invite_only",
      githubEnabled: false,
      googleEnabled: false,
      smtpEnabled: false,
    },
  })
  const setupMutation = useMutation({
    mutationFn: (values: SetupForm) =>
      apiFetch("/setup", {
        method: "POST",
        body: JSON.stringify({
          mutationId: crypto.randomUUID(),
          appName: values.appName,
          publicAppUrl: values.publicAppUrl,
          owner: {
            name: values.name,
            email: values.email,
            username: values.username,
            password: values.password,
          },
          storage: {
            endpoint: values.s3Endpoint,
            region: values.s3Region,
            bucket: values.s3Bucket,
            accessKeyId: values.s3AccessKeyId,
            secretAccessKey: values.s3SecretAccessKey,
            forcePathStyle: values.s3ForcePathStyle,
            publicBaseUrl: values.s3PublicBaseUrl,
          },
          quotas: {
            defaultUserQuotaBytes: Math.round(values.defaultUserQuotaGb * 1024 ** 3),
            globalQuotaBytes: values.globalQuotaGb
              ? Math.round(values.globalQuotaGb * 1024 ** 3)
              : undefined,
          },
          registrationMode: values.registrationMode,
          oauth: {
            githubEnabled: values.githubEnabled,
            googleEnabled: values.googleEnabled,
          },
          smtpEnabled: values.smtpEnabled,
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["setup-status"] })
      await queryClient.invalidateQueries({ queryKey: ["current-user"] })
      onComplete()
    },
  })
  const testS3Mutation = useMutation({
    mutationFn: (values: SetupForm) =>
      apiFetch<{ connected: boolean }>("/setup/test-s3", {
        method: "POST",
        body: JSON.stringify({
          endpoint: values.s3Endpoint,
          region: values.s3Region,
          bucket: values.s3Bucket,
          accessKeyId: values.s3AccessKeyId,
          secretAccessKey: values.s3SecretAccessKey,
          forcePathStyle: values.s3ForcePathStyle,
          publicBaseUrl: values.s3PublicBaseUrl,
        }),
      }),
    onSuccess: (_, values) => {
      setVerifiedStorageSignature(storageSignature(values))
      toast.success("S3 connection verified")
      void queryClient.invalidateQueries({ queryKey: ["setup-status"] })
    },
  })
  const submitSetup = (values: SetupForm) => {
    if (verifiedStorageSignature !== storageSignature(values)) {
      toast.error("Test the current S3 settings before completing setup")
      return
    }
    setupMutation.mutate(values)
  }

  return (
    <div className="min-h-svh bg-background px-4 py-8 text-foreground">
      <form
        className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-2"
        onSubmit={form.handleSubmit(submitSetup)}
      >
        <div className="lg:col-span-2">
          <FolderIcon className="mb-3 size-9 text-primary" />
          <h1 className="font-heading text-3xl font-semibold">Set up Shelf</h1>
        </div>
        <Panel title="Owner">
          <TextInput label="Name" {...form.register("name")} />
          <TextInput label="Email" type="email" {...form.register("email")} />
          <TextInput label="Username" {...form.register("username")} />
          <TextInput label="Password" type="password" {...form.register("password")} />
        </Panel>
        <Panel title="Instance">
          <TextInput label="App name" {...form.register("appName")} />
          <TextInput label="Public app URL" {...form.register("publicAppUrl")} />
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Registration</span>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3"
              {...form.register("registrationMode")}
            >
              <option value="invite_only">Invite only</option>
              <option value="open">Open</option>
              <option value="disabled">Disabled</option>
            </select>
          </label>
        </Panel>
        <Panel title="S3 storage">
          <TextInput label="Endpoint" {...form.register("s3Endpoint")} />
          <TextInput label="Region" {...form.register("s3Region")} />
          <TextInput label="Bucket" {...form.register("s3Bucket")} />
          <TextInput label="Access key ID" {...form.register("s3AccessKeyId")} />
          <TextInput label="Secret access key" type="password" {...form.register("s3SecretAccessKey")} />
          <TextInput label="Public base URL" {...form.register("s3PublicBaseUrl")} />
          <CheckboxInput label="Force path-style URLs" {...form.register("s3ForcePathStyle")} />
          <Button
            variant="outline"
            type="button"
            onClick={form.handleSubmit((values) => testS3Mutation.mutate(values))}
          >
            Test S3 connection
          </Button>
          {testS3Mutation.error ? (
            <p className="text-sm text-destructive">{testS3Mutation.error.message}</p>
          ) : null}
          {verifiedStorageSignature ? (
            <p className="text-sm text-muted-foreground">S3 connection verified.</p>
          ) : null}
        </Panel>
        <Panel title="Limits and providers">
          <TextInput label="Default quota GB" type="number" {...form.register("defaultUserQuotaGb")} />
          <TextInput label="Global quota GB" type="number" {...form.register("globalQuotaGb")} />
          <CheckboxInput label="GitHub OAuth enabled" {...form.register("githubEnabled")} />
          <CheckboxInput label="Google OAuth enabled" {...form.register("googleEnabled")} />
          <CheckboxInput label="SMTP enabled" {...form.register("smtpEnabled")} />
        </Panel>
        <div className="lg:col-span-2">
          <Button size="lg" type="submit">Complete setup</Button>
          {setupMutation.error ? (
            <p className="mt-3 text-sm text-destructive">{setupMutation.error.message}</p>
          ) : null}
        </div>
      </form>
    </div>
  )
}

function storageSignature(values: SetupForm) {
  return JSON.stringify({
    endpoint: values.s3Endpoint,
    region: values.s3Region,
    bucket: values.s3Bucket,
    accessKeyId: values.s3AccessKeyId,
    secretAccessKey: values.s3SecretAccessKey,
    forcePathStyle: values.s3ForcePathStyle,
    publicBaseUrl: values.s3PublicBaseUrl,
  })
}

function storageSettingsSignature(values: AdminStorageForm) {
  return JSON.stringify({
    endpoint: values.endpoint,
    region: values.region,
    bucket: values.bucket,
    accessKeyId: values.accessKeyId,
    secretAccessKey: values.secretAccessKey,
    forcePathStyle: values.forcePathStyle,
    publicBaseUrl: values.publicBaseUrl,
  })
}

function storagePatch(values: AdminStorageForm) {
  return {
    endpoint: values.endpoint,
    region: values.region,
    bucket: values.bucket,
    ...(values.accessKeyId ? { accessKeyId: values.accessKeyId } : {}),
    ...(values.secretAccessKey ? { secretAccessKey: values.secretAccessKey } : {}),
    forcePathStyle: values.forcePathStyle,
    publicBaseUrl: values.publicBaseUrl,
  }
}

function smtpSettingsSignature(values: AdminSmtpForm) {
  return JSON.stringify({
    host: values.host,
    port: values.port,
    secure: values.secure,
    user: values.user,
    password: values.password,
    from: values.from,
  })
}

function smtpPatch(values: AdminSmtpForm) {
  return {
    host: values.host,
    port: Number(values.port),
    secure: values.secure,
    user: values.user || null,
    ...(values.password ? { password: values.password } : {}),
    from: values.from,
  }
}

function resetAdminForms(
  settings: Record<string, unknown> | undefined,
  settingsForm: ReturnType<typeof useForm<AdminSettingsForm>>,
  storageForm: ReturnType<typeof useForm<AdminStorageForm>>,
  smtpForm: ReturnType<typeof useForm<AdminSmtpForm>>
) {
  if (!settings) return
  settingsForm.reset({
    registrationMode:
      settings["registration.mode"] === "open" ||
      settings["registration.mode"] === "disabled"
        ? settings["registration.mode"]
        : "invite_only",
    defaultRole: settings["registration.defaultRole"] === "admin" ? "admin" : "user",
    defaultUserQuotaGb:
      typeof settings["storage.defaultUserQuotaBytes"] === "number"
        ? settings["storage.defaultUserQuotaBytes"] / 1024 ** 3
        : 10,
    globalQuotaGb:
      typeof settings["storage.globalQuotaBytes"] === "number"
        ? settings["storage.globalQuotaBytes"] / 1024 ** 3
        : "",
    publicLinksEnabled: settings["sharing.publicLinksEnabled"] !== false,
    folderSharingEnabled: settings["sharing.folderSharingEnabled"] !== false,
    defaultPublicLinkExpirationDays:
      typeof settings["sharing.defaultPublicLinkExpirationDays"] === "number"
        ? settings["sharing.defaultPublicLinkExpirationDays"]
        : 30,
    maxPublicLinkExpirationDays:
      typeof settings["sharing.maxPublicLinkExpirationDays"] === "number"
        ? settings["sharing.maxPublicLinkExpirationDays"]
        : 365,
    maxUploadMb:
      typeof settings["storage.maxFileSizeBytes"] === "number"
        ? settings["storage.maxFileSizeBytes"] / 1024 ** 2
        : 5120,
    emailVerificationRequired: settings["security.emailVerificationRequired"] === true,
    passwordMinLength:
      typeof settings["security.passwordMinLength"] === "number"
        ? settings["security.passwordMinLength"]
        : 10,
    sessionLifetimeDays:
      typeof settings["security.sessionLifetimeDays"] === "number"
        ? settings["security.sessionLifetimeDays"]
        : 30,
    trashRetentionDays:
      typeof settings["maintenance.trashRetentionDays"] === "number"
        ? settings["maintenance.trashRetentionDays"]
        : 30,
    pendingUploadExpirationMinutes:
      typeof settings["maintenance.pendingUploadExpirationMinutes"] === "number"
        ? settings["maintenance.pendingUploadExpirationMinutes"]
        : 15,
    thumbnailsEnabled: settings["maintenance.thumbnailsEnabled"] !== false,
    githubEnabled: settings["oauth.githubEnabled"] === true,
    googleEnabled: settings["oauth.googleEnabled"] === true,
    smtpEnabled: settings["smtp.enabled"] === true,
  })
  storageForm.reset({
    endpoint:
      typeof settings["storage.endpoint"] === "string"
        ? settings["storage.endpoint"]
        : "",
    region:
      typeof settings["storage.region"] === "string"
        ? settings["storage.region"]
        : "auto",
    bucket:
      typeof settings["storage.bucket"] === "string" ? settings["storage.bucket"] : "",
    accessKeyId: "",
    secretAccessKey: "",
    forcePathStyle: settings["storage.forcePathStyle"] === true,
    publicBaseUrl:
      typeof settings["storage.publicBaseUrl"] === "string"
        ? settings["storage.publicBaseUrl"]
        : "",
  })
  smtpForm.reset({
    host: typeof settings["smtp.host"] === "string" ? settings["smtp.host"] : "",
    port: typeof settings["smtp.port"] === "number" ? settings["smtp.port"] : 587,
    secure: settings["smtp.secure"] === true,
    user: typeof settings["smtp.user"] === "string" ? settings["smtp.user"] : "",
    password: "",
    from: typeof settings["smtp.from"] === "string" ? settings["smtp.from"] : "",
  })
}

function SectionContent({
  currentUser,
  onOpenFolder,
  onSelectNode,
  section,
  selectedNode,
}: {
  currentUser: CurrentUser["user"]
  onOpenFolder: (id: string) => void
  onSelectNode: (node: ShelfNode) => void
  section: Section
  selectedNode: ShelfNode | null
}) {
  if (section === "shared") {
    return <SharedPanel onOpenFolder={onOpenFolder} onSelectNode={onSelectNode} selectedNode={selectedNode} />
  }
  if (section === "public-links") return <PublicLinksPanel />
  if (section === "recent") {
    return <RecentPanel onOpenFolder={onOpenFolder} onSelectNode={onSelectNode} selectedNode={selectedNode} />
  }
  if (section === "trash") {
    return <TrashPanel onOpenFolder={onOpenFolder} onSelectNode={onSelectNode} selectedNode={selectedNode} />
  }
  if (section === "admin") return <AdminPanel />
  return <ProfilePanel user={currentUser} />
}

function SharedPanel(props: {
  onOpenFolder: (id: string) => void
  onSelectNode: (node: ShelfNode) => void
  selectedNode: ShelfNode | null
}) {
  const { data } = useQuery({
    queryKey: ["shared-with-me"],
    queryFn: () => apiFetch<{ items: Array<{ node: ShelfNode; permission: string }> }>("/shares/shared-with-me"),
  })
  return (
    <NodeListPanel
      emptyLabel="Nothing has been shared with you"
      nodes={data?.items.map((item) => item.node) ?? []}
      title="Shared with me"
      {...props}
    />
  )
}

function RecentPanel(props: {
  onOpenFolder: (id: string) => void
  onSelectNode: (node: ShelfNode) => void
  selectedNode: ShelfNode | null
}) {
  const { data } = useQuery({
    queryKey: ["recent"],
    queryFn: () => apiFetch<{ nodes: ShelfNode[] }>("/nodes/recent"),
  })
  return (
    <NodeListPanel
      emptyLabel="No recent files"
      nodes={data?.nodes ?? []}
      title="Recent"
      {...props}
    />
  )
}

function TrashPanel(props: {
  onOpenFolder: (id: string) => void
  onSelectNode: (node: ShelfNode) => void
  selectedNode: ShelfNode | null
}) {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: ["trash"],
    queryFn: () => apiFetch<{ nodes: ShelfNode[] }>("/trash"),
  })
  const restoreMutation = useMutation({
    mutationFn: (nodeId: string) =>
      apiFetch(`/trash/${nodeId}/restore`, {
        method: "POST",
        body: JSON.stringify({ mutationId: crypto.randomUUID() }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] })
      await queryClient.invalidateQueries({ queryKey: ["nodes"] })
    },
  })
  const permanentDeleteMutation = useMutation({
    mutationFn: (nodeId: string) =>
      apiFetch(`/trash/${nodeId}`, {
        method: "DELETE",
        body: JSON.stringify({ mutationId: crypto.randomUUID() }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] })
      await queryClient.invalidateQueries({ queryKey: ["nodes"] })
    },
  })
  return (
    <div>
      <NodeListPanel
        emptyLabel="Trash is empty"
        nodes={data?.nodes ?? []}
        title="Trash"
        {...props}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {(data?.nodes ?? []).slice(0, 5).map((node) => (
          <React.Fragment key={node.id}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => restoreMutation.mutate(node.id)}
            >
              <ArrowUturnLeftIcon className="size-4" />
              Restore {node.name}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => permanentDeleteMutation.mutate(node.id)}
            >
              <TrashIcon className="size-4" />
              Delete {node.name}
            </Button>
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

function PublicLinksPanel() {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: ["public-links"],
    queryFn: () => apiFetch<{ publicLinks: PublicLinkRow[] }>("/public-links"),
  })
  const updateMutation = useMutation({
    mutationFn: (input: { id: string; status: "active" | "disabled" }) =>
      apiFetch(`/public-links/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: input.status,
          mutationId: crypto.randomUUID(),
        }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["public-links"] }),
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/public-links/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ mutationId: crypto.randomUUID() }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["public-links"] }),
  })
  const rows = data?.publicLinks ?? []
  return (
    <Panel title="Public links">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No public links created.</p>
      ) : (
        <div className="divide-y divide-border">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3 py-3 text-sm">
              <div className="min-w-0">
                <div className="truncate font-medium">{row.id}</div>
                <div className="text-xs text-muted-foreground">
                  <Badge variant={row.status === "active" ? "default" : "secondary"}>
                    {row.status}
                  </Badge>{" "}
                  {row.downloadCount}
                  {row.maxDownloads ? `/${row.maxDownloads}` : ""} downloads
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  aria-label="Copy link ID"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    void navigator.clipboard.writeText(row.id)
                    toast.success("Link ID copied")
                  }}
                  title="Copy link ID"
                >
                  <ClipboardDocumentIcon className="size-4" />
                </Button>
                {row.status === "active" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      updateMutation.mutate({ id: row.id, status: "disabled" })
                    }
                  >
                    Disable
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      updateMutation.mutate({ id: row.id, status: "active" })
                    }
                  >
                    Enable
                  </Button>
                )}
                <Button
                  aria-label="Delete public link"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => deleteMutation.mutate(row.id)}
                  title="Delete public link"
                >
                  <TrashIcon className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

function AdminPanel() {
  return useAdminPanel()
}

function useAdminPanel() {
  const queryClient = useQueryClient()
  const verifiedStorageSignatureRef = React.useRef<string | null>(null)
  const verifiedSmtpSignatureRef = React.useRef<string | null>(null)
  const [userDialog, setUserDialog] = React.useState<
    | { type: "quota"; user: AdminUserRow; value: string }
    | { type: "username"; user: AdminUserRow; value: string }
    | null
  >(null)
  const { data: usersData } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => apiFetch<{ users: AdminUserRow[] }>("/admin/users"),
  })
  const { data: invitesData } = useQuery({
    queryKey: ["admin-invites"],
    queryFn: () => apiFetch<{ invites: InviteRow[] }>("/admin/invites"),
  })
  const { data: settingsData } = useQuery({
    queryKey: ["admin-settings"],
    queryFn: () => apiFetch<{ settings: Record<string, unknown> }>("/settings"),
  })
  const { data: diagnosticsData } = useQuery({
    queryKey: ["admin-diagnostics"],
    queryFn: () => apiFetch<Record<string, unknown>>("/admin/diagnostics"),
  })
  const inviteForm = useForm<{ email: string; role: "admin" | "user" }>({
    defaultValues: { email: "", role: "user" },
  })
  const settingsForm = useForm<AdminSettingsForm>({
    defaultValues: {
      registrationMode: "invite_only",
      defaultRole: "user",
      defaultUserQuotaGb: 10,
      globalQuotaGb: "",
      publicLinksEnabled: true,
      folderSharingEnabled: true,
      defaultPublicLinkExpirationDays: 30,
      maxPublicLinkExpirationDays: 365,
      maxUploadMb: 5120,
      emailVerificationRequired: false,
      passwordMinLength: 10,
      sessionLifetimeDays: 30,
      trashRetentionDays: 30,
      pendingUploadExpirationMinutes: 15,
      thumbnailsEnabled: true,
      githubEnabled: false,
      googleEnabled: false,
      smtpEnabled: false,
    },
  })
  const storageForm = useForm<AdminStorageForm>({
    defaultValues: {
      endpoint: "",
      region: "auto",
      bucket: "",
      accessKeyId: "",
      secretAccessKey: "",
      forcePathStyle: false,
      publicBaseUrl: "",
    },
  })
  const smtpForm = useForm<AdminSmtpForm>({
    defaultValues: {
      host: "",
      port: 587,
      secure: false,
      user: "",
      password: "",
      from: "",
    },
  })

  React.useEffect(() => {
    resetAdminForms(settingsData?.settings, settingsForm, storageForm, smtpForm)
  }, [settingsForm, settingsData, smtpForm, storageForm])

  const userActionMutation = useMutation({
    mutationFn: (input: { userId: string; action: "suspend" | "restore" | "promote" | "demote" }) =>
      apiFetch(`/admin/users/${input.userId}/${input.action}`, {
        method: "POST",
        body: JSON.stringify({ mutationId: crypto.randomUUID() }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  })
  const quotaMutation = useMutation({
    mutationFn: (input: { userId: string; quotaGb: number }) =>
      apiFetch(`/admin/users/${input.userId}/quota`, {
        method: "PATCH",
        body: JSON.stringify({
          quotaBytes: Math.round(input.quotaGb * 1024 ** 3),
          mutationId: crypto.randomUUID(),
        }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  })
  const usernameOverrideMutation = useMutation({
    mutationFn: (input: { userId: string; username: string }) =>
      apiFetch(`/admin/users/${input.userId}/username`, {
        method: "POST",
        body: JSON.stringify({
          username: input.username,
          mutationId: crypto.randomUUID(),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-users"] })
      await queryClient.invalidateQueries({ queryKey: ["current-user"] })
    },
  })
  const ownerTransferMutation = useMutation({
    mutationFn: (userId: string) =>
      apiFetch(`/admin/owner-transfer/${userId}`, {
        method: "POST",
        body: JSON.stringify({
          confirmation: "transfer owner",
          mutationId: crypto.randomUUID(),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-users"] })
      await queryClient.invalidateQueries({ queryKey: ["current-user"] })
    },
  })
  const inviteMutation = useMutation({
    mutationFn: (values: { email: string; role: "admin" | "user" }) =>
      apiFetch<{ id: string; token: string }>("/admin/invites", {
        method: "POST",
        body: JSON.stringify({ ...values, mutationId: crypto.randomUUID() }),
      }),
    onSuccess: async (result) => {
      inviteForm.reset({ email: "", role: "user" })
      await navigator.clipboard.writeText(result.token)
      toast.success("Invite token copied")
      await queryClient.invalidateQueries({ queryKey: ["admin-invites"] })
    },
  })
  const revokeInviteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/admin/invites/${id}/revoke`, {
        method: "POST",
        body: JSON.stringify({ mutationId: crypto.randomUUID() }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-invites"] }),
  })
  const settingsMutation = useMutation({
    mutationFn: (values: AdminSettingsForm) =>
      apiFetch("/settings", {
        method: "PATCH",
        body: JSON.stringify({
          mutationId: crypto.randomUUID(),
          settings: {
            "registration.mode": values.registrationMode,
            "registration.defaultRole": values.defaultRole,
            "storage.defaultUserQuotaBytes": Math.round(Number(values.defaultUserQuotaGb) * 1024 ** 3),
            "storage.globalQuotaBytes":
              values.globalQuotaGb === ""
                ? null
                : Math.round(Number(values.globalQuotaGb) * 1024 ** 3),
            "sharing.publicLinksEnabled": values.publicLinksEnabled,
            "sharing.folderSharingEnabled": values.folderSharingEnabled,
            "sharing.defaultPublicLinkExpirationDays": Number(values.defaultPublicLinkExpirationDays),
            "sharing.maxPublicLinkExpirationDays": Number(values.maxPublicLinkExpirationDays),
            "storage.maxFileSizeBytes": Math.round(Number(values.maxUploadMb) * 1024 ** 2),
            "security.emailVerificationRequired": values.emailVerificationRequired,
            "security.passwordMinLength": Number(values.passwordMinLength),
            "security.sessionLifetimeDays": Number(values.sessionLifetimeDays),
            "maintenance.trashRetentionDays": Number(values.trashRetentionDays),
            "maintenance.pendingUploadExpirationMinutes": Number(values.pendingUploadExpirationMinutes),
            "maintenance.thumbnailsEnabled": values.thumbnailsEnabled,
            "oauth.githubEnabled": values.githubEnabled,
            "oauth.googleEnabled": values.googleEnabled,
            "smtp.enabled": values.smtpEnabled,
          },
        }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-settings"] }),
  })
  const testStorageMutation = useMutation({
    mutationFn: (values: AdminStorageForm) =>
      apiFetch<{ connected: boolean }>("/settings/test-s3", {
        method: "POST",
        body: JSON.stringify({ settings: storagePatch(values) }),
      }),
    onSuccess: (_, values) => {
      verifiedStorageSignatureRef.current = storageSettingsSignature(values)
      toast.success("S3 connection verified")
      void queryClient.invalidateQueries({ queryKey: ["admin-diagnostics"] })
    },
  })
  const storageMutation = useMutation({
    mutationFn: (values: AdminStorageForm) => {
      if (verifiedStorageSignatureRef.current !== storageSettingsSignature(values)) {
        throw new Error("Test the current S3 settings before saving")
      }
      return apiFetch("/settings", {
        method: "PATCH",
        body: JSON.stringify({
          mutationId: crypto.randomUUID(),
          settings: {
            "storage.endpoint": values.endpoint,
            "storage.region": values.region,
            "storage.bucket": values.bucket,
            ...(values.accessKeyId
              ? { "storage.accessKeyId": values.accessKeyId }
              : {}),
            ...(values.secretAccessKey
              ? { "storage.secretAccessKey": values.secretAccessKey }
              : {}),
            "storage.forcePathStyle": values.forcePathStyle,
            "storage.publicBaseUrl": values.publicBaseUrl || null,
          },
        }),
      })
    },
    onSuccess: async () => {
      storageForm.reset({
        ...storageForm.getValues(),
        accessKeyId: "",
        secretAccessKey: "",
      })
      await queryClient.invalidateQueries({ queryKey: ["admin-settings"] })
    },
  })
  const testSmtpMutation = useMutation({
    mutationFn: (values: AdminSmtpForm) =>
      apiFetch<{ connected: boolean }>("/settings/test-smtp", {
        method: "POST",
        body: JSON.stringify({ settings: smtpPatch(values) }),
      }),
    onSuccess: (_, values) => {
      verifiedSmtpSignatureRef.current = smtpSettingsSignature(values)
      toast.success("SMTP connection verified")
      void queryClient.invalidateQueries({ queryKey: ["admin-diagnostics"] })
    },
  })
  const smtpMutation = useMutation({
    mutationFn: (values: AdminSmtpForm) => {
      if (verifiedSmtpSignatureRef.current !== smtpSettingsSignature(values)) {
        throw new Error("Test the current SMTP settings before saving")
      }
      return apiFetch("/settings", {
        method: "PATCH",
        body: JSON.stringify({
          mutationId: crypto.randomUUID(),
          settings: {
            "smtp.host": values.host || null,
            "smtp.port": Number(values.port),
            "smtp.secure": values.secure,
            "smtp.user": values.user || null,
            ...(values.password ? { "smtp.password": values.password } : {}),
            "smtp.from": values.from || null,
          },
        }),
      })
    },
    onSuccess: async () => {
      smtpForm.reset({
        ...smtpForm.getValues(),
        password: "",
      })
      await queryClient.invalidateQueries({ queryKey: ["admin-settings"] })
    },
  })

  return (
    <>
      <Dialog open={Boolean(userDialog)} onOpenChange={(open) => {
        if (!open) setUserDialog(null)
      }}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (!userDialog) return
              if (userDialog.type === "quota") {
                const quotaGb = Number(userDialog.value)
                if (!Number.isFinite(quotaGb) || quotaGb <= 0) {
                  toast.error("Enter a positive quota")
                  return
                }
                quotaMutation.mutate({ userId: userDialog.user.id, quotaGb })
              } else {
                const username = userDialog.value.trim()
                if (!username) {
                  toast.error("Enter a username")
                  return
                }
                usernameOverrideMutation.mutate({
                  userId: userDialog.user.id,
                  username,
                })
              }
              setUserDialog(null)
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {userDialog?.type === "quota" ? "Set User Quota" : "Override Username"}
              </DialogTitle>
              <DialogDescription>
                {userDialog
                  ? `${userDialog.user.name} - ${userDialog.user.email}`
                  : "Update the selected user."}
              </DialogDescription>
            </DialogHeader>
            <TextInput
              label={userDialog?.type === "quota" ? "Quota in GB" : "Username"}
              min={userDialog?.type === "quota" ? 1 : undefined}
              onChange={(event) =>
                setUserDialog((current) =>
                  current ? { ...current, value: event.target.value } : current
                )
              }
              pattern={userDialog?.type === "username" ? "^[a-z0-9_]{3,32}$" : undefined}
              required
              type={userDialog?.type === "quota" ? "number" : "text"}
              value={userDialog?.value ?? ""}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setUserDialog(null)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Panel title="Users">
        <div className="overflow-hidden rounded-md border border-border">
          <Table>
            <TableHeader className="bg-muted/60 text-xs uppercase text-muted-foreground">
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(usersData?.users ?? []).map((row) => (
                <TableRow key={row.id} className="border-t border-border">
                  <TableCell className="px-3 py-2">
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.email} - @{row.username}
                    </div>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <Badge variant="outline">{row.role}</Badge>
                    {row.disabledAt ? (
                      <Badge className="ml-2" variant="secondary">
                        suspended
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="px-3 py-2">{formatBytes(row.usedBytes ?? 0)}</TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          userActionMutation.mutate({
                            userId: row.id,
                            action: row.disabledAt ? "restore" : "suspend",
                          })
                        }
                      >
                        {row.disabledAt ? "Restore" : "Suspend"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          userActionMutation.mutate({
                            userId: row.id,
                            action: row.role === "admin" ? "demote" : "promote",
                          })
                        }
                      >
                        {row.role === "admin" ? "Demote" : "Promote"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setUserDialog({ type: "quota", user: row, value: "" })
                        }}
                      >
                        Quota
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setUserDialog({ type: "username", user: row, value: row.username })
                        }}
                      >
                        Username
                      </Button>
                      {row.role !== "owner" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => ownerTransferMutation.mutate(row.id)}
                        >
                          Transfer owner
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>
      <div className="space-y-4">
        <Panel title="Settings">
          <form
            className="space-y-3"
            onSubmit={settingsForm.handleSubmit((values) =>
              settingsMutation.mutate(values)
            )}
          >
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted-foreground">Registration</span>
              <select
                className="h-9 rounded-md border border-input bg-background px-3"
                {...settingsForm.register("registrationMode")}
              >
                <option value="invite_only">Invite only</option>
                <option value="open">Open</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted-foreground">Default role</span>
              <select
                className="h-9 rounded-md border border-input bg-background px-3"
                {...settingsForm.register("defaultRole")}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <TextInput
              label="Default quota GB"
              type="number"
              step="0.1"
              {...settingsForm.register("defaultUserQuotaGb", { valueAsNumber: true })}
            />
            <TextInput
              label="Global quota GB"
              type="number"
              step="0.1"
              {...settingsForm.register("globalQuotaGb")}
            />
            <TextInput
              label="Max upload MB"
              type="number"
              step="1"
              {...settingsForm.register("maxUploadMb", { valueAsNumber: true })}
            />
            <CheckboxInput
              label="Public links enabled"
              {...settingsForm.register("publicLinksEnabled")}
            />
            <CheckboxInput
              label="Folder sharing enabled"
              {...settingsForm.register("folderSharingEnabled")}
            />
            <TextInput
              label="Default link expiration days"
              type="number"
              step="1"
              {...settingsForm.register("defaultPublicLinkExpirationDays", { valueAsNumber: true })}
            />
            <TextInput
              label="Maximum link expiration days"
              type="number"
              step="1"
              {...settingsForm.register("maxPublicLinkExpirationDays", { valueAsNumber: true })}
            />
            <CheckboxInput
              label="Require email verification"
              {...settingsForm.register("emailVerificationRequired")}
            />
            <TextInput
              label="Password minimum length"
              type="number"
              step="1"
              {...settingsForm.register("passwordMinLength", { valueAsNumber: true })}
            />
            <TextInput
              label="Session lifetime days"
              type="number"
              step="1"
              {...settingsForm.register("sessionLifetimeDays", { valueAsNumber: true })}
            />
            <TextInput
              label="Trash retention days"
              type="number"
              step="1"
              {...settingsForm.register("trashRetentionDays", { valueAsNumber: true })}
            />
            <TextInput
              label="Pending upload expiration minutes"
              type="number"
              step="1"
              {...settingsForm.register("pendingUploadExpirationMinutes", { valueAsNumber: true })}
            />
            <CheckboxInput
              label="Generate thumbnails"
              {...settingsForm.register("thumbnailsEnabled")}
            />
            <CheckboxInput label="GitHub OAuth enabled" {...settingsForm.register("githubEnabled")} />
            <CheckboxInput label="Google OAuth enabled" {...settingsForm.register("googleEnabled")} />
            <CheckboxInput label="SMTP enabled" {...settingsForm.register("smtpEnabled")} />
            <Button size="sm" type="submit">Save settings</Button>
          </form>
        </Panel>
        <Panel title="Invites">
          <form
            className="space-y-3"
            onSubmit={inviteForm.handleSubmit((values) => inviteMutation.mutate(values))}
          >
            <TextInput label="Email" type="email" {...inviteForm.register("email")} />
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted-foreground">Role</span>
              <select
                className="h-9 rounded-md border border-input bg-background px-3"
                {...inviteForm.register("role")}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <Button size="sm" type="submit">
              <UserPlusIcon className="size-4" />
              Create invite
            </Button>
          </form>
          <div className="mt-4 divide-y divide-border">
            {(invitesData?.invites ?? []).slice(0, 8).map((invite) => (
              <div key={invite.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{invite.email}</div>
                  <div className="text-xs text-muted-foreground">
                    {invite.role}
                    {invite.acceptedAt ? ", accepted" : ""}
                    {invite.revokedAt ? ", revoked" : ""}
                  </div>
                </div>
                {!invite.acceptedAt && !invite.revokedAt ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revokeInviteMutation.mutate(invite.id)}
                  >
                    Revoke
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Storage">
          <form
            className="space-y-3"
            onSubmit={storageForm.handleSubmit((values) => storageMutation.mutate(values))}
          >
            <TextInput label="S3 endpoint" {...storageForm.register("endpoint")} />
            <TextInput label="Region" {...storageForm.register("region")} />
            <TextInput label="Bucket" {...storageForm.register("bucket")} />
            <TextInput label="Access key ID" {...storageForm.register("accessKeyId")} />
            <TextInput
              label="Secret access key"
              type="password"
              {...storageForm.register("secretAccessKey")}
            />
            <TextInput label="Public CDN base URL" {...storageForm.register("publicBaseUrl")} />
            <CheckboxInput
              label="Force path-style URLs"
              {...storageForm.register("forcePathStyle")}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={storageForm.handleSubmit((values) =>
                  testStorageMutation.mutate(values)
                )}
              >
                Test storage
              </Button>
              <Button size="sm" type="submit">Save storage</Button>
            </div>
            {testStorageMutation.error ? (
              <p className="text-sm text-destructive">{testStorageMutation.error.message}</p>
            ) : null}
            {storageMutation.error ? (
              <p className="text-sm text-destructive">{storageMutation.error.message}</p>
            ) : null}
          </form>
        </Panel>
        <Panel title="SMTP">
          <form
            className="space-y-3"
            onSubmit={smtpForm.handleSubmit((values) => smtpMutation.mutate(values))}
          >
            <TextInput label="SMTP host" {...smtpForm.register("host")} />
            <TextInput
              label="SMTP port"
              type="number"
              step="1"
              {...smtpForm.register("port", { valueAsNumber: true })}
            />
            <TextInput label="SMTP user" {...smtpForm.register("user")} />
            <TextInput
              label="SMTP password"
              type="password"
              {...smtpForm.register("password")}
            />
            <TextInput label="From email" type="email" {...smtpForm.register("from")} />
            <CheckboxInput label="Use TLS" {...smtpForm.register("secure")} />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={smtpForm.handleSubmit((values) =>
                  testSmtpMutation.mutate(values)
                )}
              >
                Test SMTP
              </Button>
              <Button size="sm" type="submit">Save SMTP</Button>
            </div>
            {testSmtpMutation.error ? (
              <p className="text-sm text-destructive">{testSmtpMutation.error.message}</p>
            ) : null}
            {smtpMutation.error ? (
              <p className="text-sm text-destructive">{smtpMutation.error.message}</p>
            ) : null}
          </form>
        </Panel>
      </div>
      <Panel title="Diagnostics">
        <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(diagnosticsData ?? {}, null, 2)}
        </pre>
      </Panel>
      </div>
    </>
  )
}

function ProfilePanel({ user }: { user: CurrentUser["user"] }) {
  const queryClient = useQueryClient()
  const avatarInputRef = React.useRef<HTMLInputElement>(null)
  const form = useForm<{ name: string; username: string }>({
    defaultValues: { name: user.name, username: user.username ?? "" },
  })
  const profileMutation = useMutation({
    mutationFn: (values: { name: string }) =>
      apiFetch("/profile", {
        method: "PATCH",
        body: JSON.stringify({ name: values.name, mutationId: crypto.randomUUID() }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["current-user"] }),
  })
  const usernameMutation = useMutation({
    mutationFn: (username: string) =>
      apiFetch("/profile/username", {
        method: "POST",
        body: JSON.stringify({ username, mutationId: crypto.randomUUID() }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["current-user"] }),
  })
  const avatarMutation = useMutation({
    mutationFn: async (file: File) => {
      const session = await apiFetch<{
        uploadSessionId: string
        url: string
        expiresAt: string
      }>("/profile/avatar/upload-session", {
        method: "POST",
        body: JSON.stringify({
          mutationId: crypto.randomUUID(),
          mimeType: file.type,
          sizeBytes: file.size,
        }),
      })
      const uploadResponse = await fetch(session.url, {
        method: "PUT",
        body: file,
      })
      if (!uploadResponse.ok) throw new Error("Avatar upload failed")
      return apiFetch("/profile/avatar/" + session.uploadSessionId + "/complete", {
        method: "POST",
        body: JSON.stringify({ mutationId: crypto.randomUUID() }),
      })
    },
    onSuccess: async () => {
      toast.success("Avatar updated")
      await queryClient.invalidateQueries({ queryKey: ["current-user"] })
    },
  })
  return (
    <Panel title="Profile">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-sm font-medium">
          {user.name.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="truncate font-medium">{user.name}</div>
          <div className="truncate text-sm text-muted-foreground">{user.email}</div>
        </div>
      </div>
      <form
        className="grid max-w-md gap-3"
        onSubmit={form.handleSubmit((values) => profileMutation.mutate(values))}
      >
        <TextInput label="Name" {...form.register("name")} />
        <Button type="submit">Save profile</Button>
      </form>
      <form
        className="mt-6 grid max-w-md gap-3"
        onSubmit={form.handleSubmit((values) => usernameMutation.mutate(values.username))}
      >
        <TextInput label="Username" {...form.register("username")} />
        <Button variant="outline" type="submit">Change username</Button>
      </form>
      <div className="mt-6 grid max-w-md gap-3">
        <Label htmlFor="profile-avatar-input">Avatar</Label>
        <input
          aria-label="Upload avatar"
          id="profile-avatar-input"
          ref={avatarInputRef}
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ""
            if (!file) return
            avatarMutation.mutate(file)
          }}
          type="file"
        />
        <Button
          variant="outline"
          type="button"
          onClick={() => avatarInputRef.current?.click()}
        >
          <ArrowDownTrayIcon className="size-4" />
          Upload avatar
        </Button>
        {avatarMutation.error ? (
          <p className="text-sm text-destructive">{avatarMutation.error.message}</p>
        ) : null}
      </div>
    </Panel>
  )
}

function NodeListPanel({
  emptyLabel,
  nodes,
  onOpenFolder,
  onSelectNode,
  selectedNode,
  title,
}: {
  emptyLabel: string
  nodes: ShelfNode[]
  onOpenFolder: (id: string) => void
  onSelectNode: (node: ShelfNode) => void
  selectedNode: ShelfNode | null
  title: string
}) {
  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-4 font-heading text-2xl font-semibold">{title}</h1>
      {nodes.length === 0 ? (
        <div className="flex min-h-72 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <Table className="table-fixed">
            <TableBody>
              {nodes.map((node) => (
                <NodeRow
                  density="comfortable"
                  key={node.id}
                  node={node}
                  onOpenFolder={onOpenFolder}
                  onSelectNode={onSelectNode}
                  selected={selectedNode?.id === node.id}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function Panel({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <Card className="rounded-md shadow-none">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  )
}

function TextInput({
  id,
  label,
  ref,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string
  ref?: React.Ref<HTMLInputElement>
}) {
  const generatedId = React.useId()
  const inputId = id ?? generatedId

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <Input
        id={inputId}
        ref={ref}
        {...props}
      />
    </div>
  )
}

function CheckboxInput({
  label,
  ref,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: string
  ref?: React.Ref<HTMLInputElement>
}) {
  return (
    <Label className="flex items-center gap-2 text-sm">
      <input ref={ref} className="size-4 accent-current" type="checkbox" {...props} />
      <span>{label}</span>
    </Label>
  )
}

function DetailsPanel({ node }: { node: ShelfNode | null }) {
  return useDetailsPanel(node)
}

function useDetailsPanel(node: ShelfNode | null) {
  const queryClient = useQueryClient()
  const [nodeDialog, setNodeDialog] = React.useState<
    | { type: "rename"; value: string }
    | { type: "move"; value: string }
    | { type: "copy"; value: string }
    | null
  >(null)
  const { data: sharesData } = useQuery({
    queryKey: ["node-shares", node?.id],
    queryFn: () => apiFetch<{ shares: NodeShareRow[] }>(`/shares/${node?.id}`),
    enabled: Boolean(node),
    retry: false,
  })
  const { data: textPreviewData } = useQuery({
    queryKey: ["text-preview", node?.id, node?.revision],
    queryFn: () => apiFetch<{ text: string }>(`/nodes/${node?.id}/preview/text`),
    enabled:
      Boolean(node) &&
      node?.type === "file" &&
      (node.mimeType?.startsWith("text/") || node.mimeType === "application/json") &&
      node.sizeBytes <= 1024 * 1024,
    retry: false,
  })
  const shareForm = useForm<{ username: string; permission: "viewer" | "editor" }>({
    defaultValues: { username: "", permission: "viewer" },
  })
  const publicLinkForm = useForm<{
    password: string
    maxDownloads: string
    expiresAt: string
  }>({
    defaultValues: { password: "", maxDownloads: "", expiresAt: "" },
  })
  const shareMutation = useMutation({
    mutationFn: (values: { username: string; permission: "viewer" | "editor" }) => {
      if (!node) throw new Error("Select a file or folder")
      return apiFetch("/shares", {
        method: "POST",
        body: JSON.stringify({
          mutationId: crypto.randomUUID(),
          nodeId: node.id,
          username: values.username,
          permission: values.permission,
        }),
      })
    },
    onSuccess: async () => {
      shareForm.reset({ username: "", permission: "viewer" })
      toast.success("Share created")
      await queryClient.invalidateQueries({ queryKey: ["shared-with-me"] })
      await queryClient.invalidateQueries({ queryKey: ["node-shares", node?.id] })
    },
  })
  const lookupUserMutation = useMutation({
    mutationFn: (username: string) =>
      apiFetch<{ user: { username: string; name: string } }>(
        `/users/lookup?username=${encodeURIComponent(username)}`
      ),
    onSuccess: (result) => {
      toast.success(`Found ${result.user.name} (@${result.user.username})`)
      void queryClient.invalidateQueries({ queryKey: ["node-shares", node?.id] })
    },
  })
  const updateShareMutation = useMutation({
    mutationFn: (input: { userId: string; permission: "viewer" | "editor" }) => {
      if (!node) throw new Error("Select a file or folder")
      return apiFetch(`/shares/${node.id}/${input.userId}`, {
        method: "PATCH",
        body: JSON.stringify({
          permission: input.permission,
          mutationId: crypto.randomUUID(),
        }),
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["node-shares", node?.id] }),
  })
  const revokeShareMutation = useMutation({
    mutationFn: (userId: string) => {
      if (!node) throw new Error("Select a file or folder")
      return apiFetch(`/shares/${node.id}/${userId}`, {
        method: "DELETE",
        body: JSON.stringify({ mutationId: crypto.randomUUID() }),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["shared-with-me"] })
      await queryClient.invalidateQueries({ queryKey: ["node-shares", node?.id] })
    },
  })
  const publicLinkMutation = useMutation({
    mutationFn: (values: { password: string; maxDownloads: string; expiresAt: string }) => {
      if (!node) throw new Error("Select a file or folder")
      return apiFetch<{ id: string; token: string }>("/public-links", {
        method: "POST",
        body: JSON.stringify({
          mutationId: crypto.randomUUID(),
          nodeId: node.id,
          password: values.password || undefined,
          maxDownloads: values.maxDownloads ? Number(values.maxDownloads) : undefined,
          expiresAt: values.expiresAt ? new Date(values.expiresAt).toISOString() : undefined,
        }),
      })
    },
    onSuccess: async (result) => {
      publicLinkForm.reset({ password: "", maxDownloads: "", expiresAt: "" })
      await navigator.clipboard.writeText(result.token)
      toast.success("Public link token copied")
      await queryClient.invalidateQueries({ queryKey: ["public-links"] })
    },
  })
  const renameMutation = useMutation({
    mutationFn: (name: string) => {
      if (!node) throw new Error("Select a file or folder")
      return apiFetch(`/nodes/${node.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          baseNodeRevision: node.revision,
          mutationId: crypto.randomUUID(),
        }),
      })
    },
    onSuccess: async () => {
      toast.success("Renamed")
      await queryClient.invalidateQueries({ queryKey: ["nodes"] })
      await queryClient.invalidateQueries({ queryKey: ["recent"] })
    },
  })
  const moveMutation = useMutation({
    mutationFn: (parentId: string | null) => {
      if (!node) throw new Error("Select a file or folder")
      return apiFetch(`/nodes/${node.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          parentId,
          baseNodeRevision: node.revision,
          mutationId: crypto.randomUUID(),
        }),
      })
    },
    onSuccess: async () => {
      toast.success("Moved")
      await queryClient.invalidateQueries({ queryKey: ["nodes"] })
      await queryClient.invalidateQueries({ queryKey: ["recent"] })
    },
  })
  const copyMutation = useMutation({
    mutationFn: (input: { parentId: string | null; name?: string }) => {
      if (!node) throw new Error("Select a file or folder")
      return apiFetch(`/nodes/${node.id}/copy`, {
        method: "POST",
        body: JSON.stringify({
          parentId: input.parentId,
          name: input.name,
          mutationId: crypto.randomUUID(),
        }),
      })
    },
    onSuccess: async () => {
      toast.success("Copied")
      await queryClient.invalidateQueries({ queryKey: ["nodes"] })
      await queryClient.invalidateQueries({ queryKey: ["recent"] })
    },
  })
  const trashMutation = useMutation({
    mutationFn: () => {
      if (!node) throw new Error("Select a file or folder")
      return apiFetch(`/nodes/${node.id}`, {
        method: "DELETE",
        body: JSON.stringify({ mutationId: crypto.randomUUID() }),
      })
    },
    onSuccess: async () => {
      toast.success("Moved to trash")
      await queryClient.invalidateQueries({ queryKey: ["nodes"] })
      await queryClient.invalidateQueries({ queryKey: ["trash"] })
    },
  })
  const downloadMutation = useMutation({
    mutationFn: () => {
      if (!node) throw new Error("Select a file")
      return apiFetch<{ url: string }>(`/nodes/${node.id}/download`)
    },
    onSuccess: (result) => {
      window.location.assign(result.url)
      void queryClient.invalidateQueries({ queryKey: ["recent"] })
    },
  })
  const zipDownloadMutation = useMutation({
    mutationFn: () => {
      if (!node) throw new Error("Select a folder")
      window.location.assign(`/api/v1/nodes/${node.id}/zip`)
      return Promise.resolve()
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["recent"] }),
  })

  return (
    <>
      <Dialog open={Boolean(nodeDialog)} onOpenChange={(open) => {
        if (!open) setNodeDialog(null)
      }}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (!nodeDialog || !node) return
              const value = nodeDialog.value.trim()
              if (nodeDialog.type === "rename") {
                if (!value || value === node.name) return
                renameMutation.mutate(value)
              }
              if (nodeDialog.type === "move") {
                moveMutation.mutate(value ? value : null)
              }
              if (nodeDialog.type === "copy") {
                copyMutation.mutate({
                  parentId: node.parentId,
                  name: value || undefined,
                })
              }
              setNodeDialog(null)
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {nodeDialog?.type === "rename"
                  ? "Rename Item"
                  : nodeDialog?.type === "move"
                    ? "Move Item"
                    : "Copy Item"}
              </DialogTitle>
              <DialogDescription>
                {nodeDialog?.type === "move"
                  ? "Enter a destination folder ID, or leave it blank for root."
                  : node?.name ?? "Selected item"}
              </DialogDescription>
            </DialogHeader>
            <TextInput
              label={nodeDialog?.type === "move" ? "Destination folder ID" : "Name"}
              onChange={(event) =>
                setNodeDialog((current) =>
                  current ? { ...current, value: event.target.value } : current
                )
              }
              required={nodeDialog?.type !== "move"}
              value={nodeDialog?.value ?? ""}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNodeDialog(null)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <div className="border-b border-border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-heading text-sm font-semibold">Details</h2>
        <Button aria-label="Close details" variant="ghost" size="icon-xs">
          <XMarkIcon className="size-4" />
        </Button>
      </div>

      {node ? (
        <div className="space-y-4 text-sm">
          <div className="flex items-center gap-3">
            {node.type === "folder" ? (
              <FolderIcon className="size-8 text-primary" />
            ) : (
              <DocumentIcon className="size-8 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <div className="truncate font-medium">{node.name}</div>
              <div className="text-xs text-muted-foreground">{node.type}</div>
            </div>
          </div>
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Size</dt>
              <dd>{formatBytes(node.sizeBytes)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Revision</dt>
              <dd>{node.revision}</dd>
            </div>
          </dl>
          {node.type === "file" ? (
            textPreviewData ? (
              <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted p-3 text-xs whitespace-pre-wrap">
                {textPreviewData.text}
              </pre>
            ) : node.mimeType?.startsWith("image/") ? (
              <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
                Image preview will appear after thumbnail generation.
              </div>
            ) : node.mimeType === "application/pdf" ? (
              <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
                PDF preview is not rendered in v1.
              </div>
            ) : node.mimeType?.startsWith("video/") || node.mimeType?.startsWith("audio/") ? (
              <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
                Media playback preview is not rendered in v1.
              </div>
            ) : null
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setNodeDialog({ type: "rename", value: node.name })
              }}
            >
              Rename
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setNodeDialog({ type: "move", value: node.parentId ?? "" })
              }}
            >
              Move
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setNodeDialog({ type: "copy", value: `${node.name} copy` })
              }}
            >
              Copy
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => trashMutation.mutate()}
            >
              <TrashIcon className="size-4" />
              Trash
            </Button>
          </div>
          {node.type === "file" ? (
            <Button
              className="w-full"
              variant="outline"
              size="sm"
              onClick={() => downloadMutation.mutate()}
            >
              <ArrowDownTrayIcon className="size-4" />
              Download
            </Button>
          ) : (
            <Button
              className="w-full"
              variant="outline"
              size="sm"
              onClick={() => zipDownloadMutation.mutate()}
            >
              <ArrowDownTrayIcon className="size-4" />
              Download ZIP
            </Button>
          )}
          <form
            className="space-y-2 rounded-md border border-border p-3"
            onSubmit={shareForm.handleSubmit((values) => shareMutation.mutate(values))}
          >
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <ShareIcon className="size-4" />
              Share by username
            </div>
            <TextInput label="Username" {...shareForm.register("username")} />
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => lookupUserMutation.mutate(shareForm.getValues("username"))}
            >
              Check user
            </Button>
            {lookupUserMutation.error ? (
              <p className="text-xs text-destructive">{lookupUserMutation.error.message}</p>
            ) : null}
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted-foreground">Permission</span>
              <select
                className="h-9 rounded-md border border-input bg-background px-3"
                {...shareForm.register("permission")}
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
            </label>
            <Button size="sm" type="submit">Create share</Button>
            {shareMutation.error ? (
              <p className="text-xs text-destructive">{shareMutation.error.message}</p>
            ) : null}
            {(sharesData?.shares ?? []).length > 0 ? (
              <div className="divide-y divide-border pt-2">
                {(sharesData?.shares ?? []).map((share) => (
                  <div
                    key={share.userId}
                    className="flex items-center justify-between gap-2 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{share.username}</div>
                      <div className="truncate text-xs text-muted-foreground">{share.email}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <select
                        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                        value={share.permission}
                        onChange={(event) =>
                          updateShareMutation.mutate({
                            userId: share.userId,
                            permission: event.target.value as "viewer" | "editor",
                          })
                        }
                      >
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                      </select>
                      <Button
                        aria-label="Revoke share"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => revokeShareMutation.mutate(share.userId)}
                        title="Revoke share"
                      >
                        <XMarkIcon className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </form>
          <form
            className="space-y-2 rounded-md border border-border p-3"
            onSubmit={publicLinkForm.handleSubmit((values) =>
              publicLinkMutation.mutate(values)
            )}
          >
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <GlobeAltIcon className="size-4" />
              Public access
            </div>
            <TextInput
              label="Password"
              type="password"
              {...publicLinkForm.register("password")}
            />
            <TextInput
              label="Max downloads"
              type="number"
              {...publicLinkForm.register("maxDownloads")}
            />
            <TextInput
              label="Expires at"
              type="datetime-local"
              {...publicLinkForm.register("expiresAt")}
            />
            <Button size="sm" type="submit">
              <LinkIcon className="size-4" />
              Create link
            </Button>
            {publicLinkMutation.error ? (
              <p className="text-xs text-destructive">{publicLinkMutation.error.message}</p>
            ) : null}
          </form>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Select a file or folder to view metadata, sharing, and public link controls.
        </p>
      )}
      </div>
    </>
  )
}

function UploadDrawer({
  cancel,
  progress,
  retry,
  tasks,
}: {
  cancel: (taskId: string) => void
  progress: number
  retry: (taskId: string) => void
  tasks: ReturnType<typeof useUploadStore.getState>["tasks"]
}) {
  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-heading text-sm font-semibold">Upload queue</h2>
        <span className="text-xs text-muted-foreground">{Math.round(progress * 100)}%</span>
      </div>
      <Progress className="mb-3" value={Math.round(progress * 100)} />
      <div className="space-y-2">
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active uploads.</p>
        ) : (
          tasks.slice(-6).map((task) => (
            <div key={task.id} className="rounded-md border border-border p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 truncate text-sm font-medium">{task.file.name}</div>
                <div className="flex gap-1">
                  {task.status === "failed" ? (
                    <Button
                      aria-label={`Retry ${task.file.name}`}
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => retry(task.id)}
                    >
                      <ArrowPathIcon className="size-3" />
                    </Button>
                  ) : null}
                  {task.status === "uploading" || task.status === "queued" ? (
                    <Button
                      aria-label={`Cancel ${task.file.name}`}
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => cancel(task.id)}
                    >
                      <XMarkIcon className="size-3" />
                    </Button>
                  ) : null}
                </div>
              </div>
              <Progress className="mt-2" value={Math.round(task.progress * 100)} />
              <div className="mt-1 text-xs text-muted-foreground">
                {task.status}
                {task.etaSeconds ? `, ${Math.ceil(task.etaSeconds)}s remaining` : ""}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

interface DroppedEntry {
  isFile: boolean
  isDirectory: boolean
  name: string
}

interface DroppedFileEntry extends DroppedEntry {
  file: (callback: (file: File) => void, errorCallback?: (error: DOMException) => void) => void
}

interface DroppedDirectoryEntry extends DroppedEntry {
  createReader: () => {
    readEntries: (
      callback: (entries: DroppedEntry[]) => void,
      errorCallback?: (error: DOMException) => void
    ) => void
  }
}

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => DroppedEntry | null
}

async function extractDroppedFiles(dataTransfer: DataTransfer) {
  const entries = Array.from(dataTransfer.items)
    .map(
      (item) =>
        (item as DataTransferItemWithEntry).webkitGetAsEntry?.() as
          | DroppedEntry
          | null
          | undefined
    )
    .filter((entry): entry is DroppedEntry => Boolean(entry))
  return (await Promise.all(entries.map((entry) => readDroppedEntry(entry, "")))).flat()
}

async function readDroppedEntry(entry: DroppedEntry, parentPath: string): Promise<File[]> {
  const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      ;(entry as DroppedFileEntry).file(resolve, reject)
    })
    Object.defineProperty(file, "webkitRelativePath", {
      configurable: true,
      value: relativePath,
    })
    return [file]
  }

  if (!entry.isDirectory) return []
  const reader = (entry as DroppedDirectoryEntry).createReader()
  const children = await readAllDirectoryEntries(reader)
  return (
    await Promise.all(
      children.map((child) => readDroppedEntry(child, relativePath))
    )
  ).flat()
}

async function readAllDirectoryEntries(
  reader: ReturnType<DroppedDirectoryEntry["createReader"]>
): Promise<DroppedEntry[]> {
  const children = await new Promise<DroppedEntry[]>((resolve, reject) => {
    reader.readEntries(resolve, reject)
  })
  if (children.length === 0) return []
  return [...children, ...(await readAllDirectoryEntries(reader))]
}
