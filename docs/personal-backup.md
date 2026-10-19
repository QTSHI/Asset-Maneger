# 个人家庭版：数据库备份与恢复

资产记录保存在一个 SQLite 数据库中。运行中的数据库采用 WAL 模式，不能只复制 `database.sqlite` 文件；最近提交的数据可能仍在 `-wal` 文件里。`npm run backup` 使用 SQLite 在线备份接口生成单文件快照，可以在网站运行时执行，并在独立恢复验证成功后记录状态、清理本任务的旧备份。

## 创建备份

在项目目录运行：

```sh
npm run backup
```

默认源库是项目根目录的 `database.sqlite`；默认备份目录是项目同级的 `asset-tracker-backups`。首次运行会创建权限为 `0700` 的目录，每份备份文件的权限为 `0600`。备份目录必须在项目目录之外，因此不会进入网站静态文件或 Git 仓库；项目现有的 `*.sqlite.backup` 忽略规则也覆盖备份文件名。

如果部署时数据库或备份目录位于其他位置，明确指定路径：

```sh
ASSET_TRACKER_DB_PATH=/path/to/database.sqlite \
ASSET_TRACKER_BACKUP_DIR=/private/path/asset-tracker-backups \
npm run backup
```

源库不存在时命令直接失败，不会创建空库。已有备份目录必须归运行命令的用户所有，且没有组或其他用户权限；必要时先由管理员设置目录权限。备份目录不能是符号链接。命令只输出成功、失败和清理份数，不输出资产内容或完整文件路径。

每次备份都会先生成临时文件，用它在临时目录还原一份副本，并检查 `PRAGMA integrity_check`、资产表和读取能力。只有验证通过才会生成最终的 `.sqlite.backup` 文件。失败时删除未完成的临时备份，保留旧备份。

默认保留本任务最近 **30 份**已验证备份，可通过 `ASSET_TRACKER_BACKUP_KEEP` 调整，最少 2 份。清理只发生在新备份验证并保存成功之后；只删除私有记录中由本任务创建、名称符合规则且文件身份没有变化的普通文件。源数据库、符号链接、硬链接、手工复制或修改过的文件、没有本任务记录的旧备份均不会删除。因此备份目录中的实际文件数量可能多于保留份数，应另行核对这些文件。

同一目录一次只允许一个备份任务运行，第二个任务返回非零退出码。正常退出会删除 `.asset-tracker-backup.lock`。若进程被强行终止，该锁可能保留：先通过任务日志、锁中的进程号和系统进程列表确认没有备份进程运行，再由管理员移除这个锁文件，重新运行备份。不要为了处理锁而删除数据库或现有备份。

## 查看状态和接入告警

```sh
npm run backup:check
```

使用与网站及备份任务相同的 `ASSET_TRACKER_DB_PATH`、`ASSET_TRACKER_BACKUP_DIR`。网站“数据状态”页也会展示最近尝试、最近成功、有效期限以及需要处理的错误；页面不提供服务器路径设置。状态只读取私有备份记录和最近文件的元信息，不会打开或修改业务数据库。

默认有效期限为 **36 小时**，可用 `ASSET_TRACKER_BACKUP_FRESH_HOURS` 设置为 1 至 8760 小时。只有最近任务成功、独立恢复检查通过、备份文件仍未变化并且没有超过有效期限时，检查命令才退出 `0`。未配置、未运行、运行中、失败、过期、最近文件丢失或发生变化均退出 `1`，便于接入现有监控。命令和 HTTP 状态都使用固定友好错误，详细服务器错误应由管理员结合系统日志和目录权限排查。

记录绑定当前配置的源数据库路径，改为其他数据库后不会沿用原库的成功状态。网站和任务必须配置相同路径；本地演示数据库也必须单独备份才会显示已验证。目录里只有旧备份、没有新任务的验证记录时，状态显示“尚无已验证备份”。备份状态不会证明定时器已启用、异地副本已完成或云端加密可用。

## 每日定时任务示例（Linux systemd）

仓库提供以下示例，需由服务器管理员按实际部署路径安装；本地开发和网站启动均不会安装或启用这些任务：

- `deploy/systemd/stone-wealth-backup.service`：使用与网站相同的服务用户，执行在线备份和恢复验证。
- `deploy/systemd/stone-wealth-backup.timer`：每天北京时间 03:15 后随机延迟最多 15 分钟运行；机器关机错过时，下次启动补跑。
- `deploy/systemd/backup.env.example`：源库、备份目录、保留份数和有效期限配置。

安装前先确认 Node 路径、项目目录、服务用户以及数据库实际位置。示例使用 `/opt/asset-tracker`、`/var/lib/stone-wealth/data/database.sqlite` 和 `/var/backups/stone-wealth`，服务文件中的 `ReadWritePaths` 必须同步调整。由管理员创建备份目录并设为网站服务用户所有、权限 `0700`；将环境文件保存在仓库外的 `/etc/stone-wealth/backup.env`，权限 `0600`。网站服务也应加载其中的数据库和备份设置。验证 `/usr/bin/node` 符合项目支持的 Node 版本后，再安装单元文件到 `/etc/systemd/system/`。

```sh
sudo systemctl daemon-reload
sudo systemctl start stone-wealth-backup.service
sudo journalctl -u stone-wealth-backup.service --since today
sudo systemctl enable --now stone-wealth-backup.timer
sudo systemctl list-timers stone-wealth-backup.timer
```

先检查一次手工启动的任务确实成功，且状态页显示最近验证成功，再启用定时器。`journalctl` 和 `systemctl status` 能查看退出码与运行时间。服务超时或进程中断会保留现有备份和锁；按上文处理遗留锁后重试。

要收到通知，可在服务的 `OnFailure=` 中接入服务器已有的告警单元，或让已有监控读取该服务的失败状态。通知渠道及凭据应存放在仓库外，由管理员配置；示例未配置邮件、Webhook 或任何外发通知。还应让独立监控定期使用相同环境执行 `backup:check`，非零时发出告警；这样定时器被停用、机器长期未备份等“没有启动任务”的情况也能发现。检查时间应避开正在备份的时段。

本机备份仍无法应对整机丢失或磁盘损坏。建议定期将验证成功的备份复制到加密的其他设备或存储位置，并监控复制结果。异地复制、加密和实际通知渠道需要在部署环境配置。

## 恢复演练或真实恢复

1. 先停止网站服务和所有写数据库的同步任务，确认没有进程仍在使用旧数据库。
2. 将当前 `database.sqlite` **连同**可能存在的 `database.sqlite-wal` 和 `database.sqlite-shm` 一起移入带日期的保留目录。不要直接覆盖一个仍有 WAL 文件的数据库。
3. 将选定的 `.sqlite.backup` 复制为新的 `database.sqlite`，设为只允许服务用户读写（`0600`），并确保目录可由服务用户访问。
4. 用 SQLite 打开新数据库，执行 `PRAGMA integrity_check;`，确认结果为 `ok`；再启动网站，核对资产记录。恢复失败时可以停服后将第 2 步保留的三类文件一起放回。

恢复演练请在独立测试目录或测试环境执行，不要在正式数据库上试验。备份文件包含完整资产数据，应与正式数据库按同等级别保护。
