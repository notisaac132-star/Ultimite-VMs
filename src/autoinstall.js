// Hands-free Linux installs for Quick Setup (QEMU engine).
//
// The installer's kernel and initrd are copied off the ISO and booted directly, with each distro's own
// automatic-install switch on the kernel command line. The answer file is served by a small web server
// in this app; inside the VM, QEMU's network shows this computer as 10.0.2.2.
// Every distro ends with the account "user" / password "user", logged in automatically.
const http = require("http");
const fs = require("fs");
const path = require("path");
const iso9660 = require("./iso9660");

const USER = "user";
const PASSWORD = "user";
// SHA-512 crypt of PASSWORD (openssl passwd -6), for installers that only take a hashed password.
const PASSWORD_HASH = "$6$UltimateVMs$t36ORLgJ.z6l4IrAB4SqCW9xnl5Ngto0f9CNgVktbueCwZMn3YV002AN8G3qwA66ga2HQOpd4e/suPzYeuJYP1";

const gdmAutoLogin = `[daemon]\\nAutomaticLoginEnable=true\\nAutomaticLogin=${USER}\\n`;

// "en-US" → { locale: "en_US.UTF-8", keyboard: "us" }
function localeOf(tag = "en-US") {
  const [lang, region] = tag.split("-");
  const full = region ? `${lang}_${region.toUpperCase()}` : { en: "en_US", de: "de_DE", fr: "fr_FR", es: "es_ES", it: "it_IT", pt: "pt_PT", nl: "nl_NL" }[lang] || "en_US";
  const keyboard = { "en-GB": "gb", de: "de", fr: "fr", es: "es", it: "it", pt: "pt", nl: "us", sv: "se", da: "dk", nb: "no", fi: "fi", pl: "pl" }[tag] ||
    { de: "de", fr: "fr", es: "es", it: "it", pt: "pt", sv: "se", da: "dk", nb: "no", fi: "fi", pl: "pl" }[lang] || "us";
  return { locale: `${full}.UTF-8`, keyboard };
}

const ANSWERS = {
  // Ubuntu Desktop 24.04+ (autoinstall through cloud-init's NoCloud source).
  ubuntu: ({ locale, keyboard }) => ({
    "meta-data": "instance-id: ultimate-vms\n",
    "user-data": `#cloud-config
autoinstall:
  version: 1
  locale: ${locale}
  keyboard:
    layout: ${keyboard}
  identity:
    hostname: ubuntu
    realname: User
    username: ${USER}
    password: "${PASSWORD_HASH}"
  storage:
    layout:
      name: direct
  late-commands:
    - mkdir -p /target/etc/gdm3
    - printf '${gdmAutoLogin}' > /target/etc/gdm3/custom.conf
  shutdown: poweroff
`,
  }),

  // Fedora (Everything netinstall ISO + kickstart; packages come from Fedora's mirrors).
  fedora: ({ locale, keyboard }) => ({
    "ks.cfg": `text
lang ${locale}
keyboard ${keyboard}
timezone UTC --utc
network --bootproto=dhcp --activate
url --mirrorlist="https://mirrors.fedoraproject.org/mirrorlist?repo=fedora-$releasever&arch=$basearch"
repo --name=updates --mirrorlist="https://mirrors.fedoraproject.org/mirrorlist?repo=updates-released-f$releasever&arch=$basearch"
zerombr
clearpart --all --initlabel
autopart
bootloader
rootpw --lock
user --name=${USER} --password=${PASSWORD} --plaintext --groups=wheel
poweroff

%packages
@^workstation-product-environment
%end

%post
mkdir -p /etc/gdm
printf '${gdmAutoLogin}' > /etc/gdm/custom.conf
mkdir -p /home/${USER}/.config
touch /home/${USER}/.config/gnome-initial-setup-done
chown -R ${USER}:${USER} /home/${USER}/.config
%end
`,
  }),

  // Debian (the debian-installer that ships on the ISO, driven by a preseed file).
  debian: ({ locale, keyboard }) => ({
    "preseed.cfg": `d-i debian-installer/locale string ${locale.replace(".UTF-8", "")}
d-i keyboard-configuration/xkb-keymap select ${keyboard}
d-i netcfg/choose_interface select auto
d-i netcfg/get_hostname string debian
d-i netcfg/get_domain string local
d-i mirror/country string manual
d-i mirror/http/hostname string deb.debian.org
d-i mirror/http/directory string /debian
d-i mirror/http/proxy string
d-i passwd/root-login boolean false
d-i passwd/user-fullname string User
d-i passwd/username string ${USER}
d-i passwd/user-password password ${PASSWORD}
d-i passwd/user-password-again password ${PASSWORD}
d-i user-setup/allow-password-weak boolean true
d-i clock-setup/utc boolean true
d-i time/zone string UTC
d-i partman-auto/method string regular
d-i partman-auto/choose_recipe select atomic
d-i partman-lvm/device_remove_lvm boolean true
d-i partman-md/device_remove_md boolean true
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true
d-i apt-setup/cdrom/set-first boolean false
d-i apt-setup/non-free-firmware boolean true
tasksel tasksel/first multiselect standard, gnome-desktop
d-i pkgsel/upgrade select none
popularity-contest popularity-contest/participate boolean false
d-i grub-installer/only_debian boolean true
d-i grub-installer/bootdev string default
d-i finish-install/reboot_in_progress note
d-i debian-installer/exit/poweroff boolean true
d-i preseed/late_command string in-target sh -c 'mkdir -p /etc/gdm3 && printf "${gdmAutoLogin}" > /etc/gdm3/daemon.conf'
`,
  }),

  // Linux Mint (Ubiquity installer, preseeded).
  mint: ({ locale, keyboard }) => ({
    "preseed.cfg": `d-i debian-installer/locale string ${locale.replace(".UTF-8", "")}
d-i keyboard-configuration/layoutcode string ${keyboard}
d-i time/zone string UTC
d-i clock-setup/utc boolean true
d-i partman-auto/method string regular
d-i partman-auto/choose_recipe select atomic
d-i partman-lvm/device_remove_lvm boolean true
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true
d-i passwd/user-fullname string User
d-i passwd/username string ${USER}
d-i passwd/user-password password ${PASSWORD}
d-i passwd/user-password-again password ${PASSWORD}
d-i passwd/auto-login boolean true
d-i user-setup/allow-password-weak boolean true
d-i netcfg/get_hostname string mint
ubiquity ubiquity/summary note
ubiquity ubiquity/poweroff boolean true
`,
  }),
};

// Where each installer's kernel lives on its ISO, and the kernel command line that starts it hands-free.
const BOOT = {
  ubuntu: { dirs: ["casper"], cmdline: (url) => `autoinstall ds=nocloud-net;s=${url}/ --- quiet splash` },
  mint: { dirs: ["casper"], cmdline: (url) => `boot=casper automatic-ubiquity noprompt url=${url}/preseed.cfg quiet splash --` },
  fedora: { dirs: ["images/pxeboot"], cmdline: (url, label) => `inst.stage2=hd:LABEL=${label.replace(/ /g, "\\x20")} inst.ks=${url}/ks.cfg quiet` },
  debian: {
    dirs: ["install", "install.amd", "install.a64"],
    cmdline: (url) => `auto=true priority=critical url=${url}/preseed.cfg interface=auto hostname=debian domain=local ---`,
  },
};

// ---------- The answer-file web server ----------

const served = new Map(); // vm id -> { file name -> content }
let server = null;
let port = 0;

function ensureServer() {
  if (server) return Promise.resolve(port);
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const [, id, file] = decodeURIComponent(req.url.split("?")[0]).split("/");
      const content = served.get(id)?.[file];
      if (content == null) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(content);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve(port);
    });
  });
}

// For QEMU: returns { kernel, initrd, append } to boot the installer hands-free, or null when this
// VM doesn't do an automatic install (then it simply boots the disc).
async function prepareBoot(vm, dir) {
  const boot = BOOT[vm.autoInstall];
  if (!boot || !vm.iso || vm.installed) return null;

  const disc = iso9660.open(vm.iso);
  try {
    let found = null;
    for (const d of boot.dirs) {
      const names = disc.list(d);
      const kernel = names.find((n) => /^vmlinuz/i.test(n));
      const initrd = names.find((n) => /^initrd/i.test(n));
      if (kernel && initrd) {
        found = { kernel: `${d}/${kernel}`, initrd: `${d}/${initrd}` };
        break;
      }
    }
    if (!found) throw new Error("Couldn't find the installer on this disc, so it can't install by itself. Use Advanced Setup instead.");
    const kernel = path.join(dir, "installer-kernel");
    const initrd = path.join(dir, "installer-initrd");
    if (!fs.existsSync(kernel)) disc.extract(found.kernel, kernel);
    if (!fs.existsSync(initrd)) disc.extract(found.initrd, initrd);

    served.set(vm.id, ANSWERS[vm.autoInstall](localeOf(vm.culture)));
    const p = await ensureServer();
    return { kernel, initrd, append: boot.cmdline(`http://10.0.2.2:${p}/${vm.id}`, disc.volumeId) };
  } finally {
    disc.close();
  }
}

// After the installer powers the VM off: did it actually install? (A real install leaves a big disk.)
function looksInstalled(dir) {
  try {
    return fs.statSync(path.join(dir, "disk.qcow2")).size > 2 * 1024 ** 3;
  } catch {
    return false;
  }
}

function cleanup(vm, dir) {
  served.delete(vm.id);
  for (const f of ["installer-kernel", "installer-initrd"]) fs.rmSync(path.join(dir, f), { force: true });
}

module.exports = { prepareBoot, looksInstalled, cleanup, ANSWERS, localeOf, USER, PASSWORD };
