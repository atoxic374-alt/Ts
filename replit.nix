{pkgs}: {
  deps = [
    pkgs.expat
    pkgs.alsa-lib
    pkgs.cairo
    pkgs.pango
    pkgs.gtk3
    pkgs.gdk-pixbuf
    pkgs.xorg.libxkbfile
    pkgs.xorg.libXtst
    pkgs.xorg.libXi
    pkgs.xorg.libXcursor
    pkgs.xorg.libXrandr
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.cups
    pkgs.atk
    pkgs.nspr
    pkgs.nss
    pkgs.chromium
  ];
}
