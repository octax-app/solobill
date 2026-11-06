import {
  Bell,
  Building2,
  FileCheck,
  FileInput,
  FileText,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  Package,
  Repeat,
  Settings,
  Type,
  Users,
} from 'lucide-react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { api, queryClient, run, useApi } from '@/lib/api'
import type { Reminder } from '@/lib/types'

const GROUPS = [
  {
    label: 'Work',
    items: [
      { to: '/', label: 'Overview', icon: LayoutDashboard },
      { to: '/customers', label: 'Customers', icon: Users },
      { to: '/subscriptions', label: 'Subscriptions', icon: Repeat },
    ],
  },
  {
    label: 'Invoices',
    items: [
      { to: '/invoices', label: 'Customer invoices', icon: FileText },
      { to: '/proformas', label: 'Proformas', icon: FileCheck },
      { to: '/originals', label: 'Original invoices', icon: FileInput },
    ],
  },
  {
    label: 'Setup',
    items: [
      { to: '/providers', label: 'Providers', icon: Building2 },
      { to: '/services', label: 'Services', icon: Package },
      { to: '/templates', label: 'Templates', icon: LayoutTemplate },
      { to: '/fonts', label: 'Fonts', icon: Type },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
]

function Reminders() {
  const reminders = useApi<Reminder[]>('/reminders')
  const navigate = useNavigate()
  const items = reminders.data ?? []
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Reminders: ${items.length}`}>
          <Bell className="size-4" />
          {items.length > 0 && <span className="text-xs">{items.length}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Reminders</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 && (
          <div className="text-muted-foreground p-2 text-sm">No reminders</div>
        )}
        {items.slice(0, 12).map((item) => (
          <DropdownMenuItem
            key={item.id}
            className="whitespace-normal"
            onSelect={async () => {
              await run(() => api.post(`/reminders/${item.id}/read`))
              navigate(item.link)
            }}
          >
            {item.message}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Layout({ email, workspace }: { email: string; workspace: string }) {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <Link to="/" className="flex flex-col px-2 py-1">
            <span className="text-base font-semibold">Octax Solobill</span>
            <span className="text-muted-foreground truncate text-xs">{workspace}</span>
          </Link>
        </SidebarHeader>
        <SidebarContent>
          {GROUPS.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <NavLink to={item.to} end={item.to === '/'}>
                        {({ isActive }) => (
                          <SidebarMenuButton isActive={isActive}>
                            <item.icon />
                            <span>{item.label}</span>
                          </SidebarMenuButton>
                        )}
                      </NavLink>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <Link
            to="/settings/account"
            className="text-muted-foreground hover:text-foreground truncate px-2 text-xs"
          >
            {email}
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="justify-start"
            onClick={async () => {
              await api.post('/auth/logout')
              queryClient.clear()
              window.location.href = '/'
            }}
          >
            <LogOut className="size-4" /> Log out
          </Button>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 items-center justify-between border-b px-4">
          <SidebarTrigger />
          <Reminders />
        </header>
        <main className="mx-auto w-full max-w-7xl p-4 md:p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
