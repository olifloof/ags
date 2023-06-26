import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Service from './service.js';
import { NotificationIFace } from '../dbus/notifications.js';
import { NOTIFICATIONS_CACHE_PATH, ensureCache, getConfig, timeout, writeFile } from '../utils.js';

type action = {
    id: string
    label: string
}

type Hints = {
    'image-data'?: GLib.Variant<'(iiibiiay)'>
    'desktop-entry'?: GLib.Variant<'s'>
    'urgency'?: GLib.Variant<'y'>
}

type Notification = {
    id: number
    appName: string
    appId: string
    appIcon: string
    summary: string
    body: string
    actions: action[]
    urgency: string
    time: { hour: number, minute :number }
    image: string|null
}

const _URGENCY = ['low', 'normal', 'critical'];

class NotificationsService extends Service{
    static { Service.register(this); }

    _notifications: Map<number, Notification>;
    _popups: Map<number, Notification>;
    _dnd: boolean;
    _idCount: number;
    _timeout: number;
    _dbus!: Gio.DBusExportedObject;

    constructor() {
        super();

        this._timeout = getConfig()?.notificationPopupTimeout || 5000;
        this._dnd = false;
        this._idCount = 1;
        this._notifications = new Map();
        this._popups = new Map();
        this._readFromFile();
        this._register();
        this._sync();
    }

    toggleDND() {
        this._dnd = !this._dnd;
        this.emit('changed');
    }

    dismiss(id: number) {
        if (!this._popups.has(id))
            return;

        this._popups.delete(id);
        this._sync();
    }

    Clear() {
        for (const [, notification] of this._notifications)
            this.CloseNotification(notification.id);
    }

    Notify(
        app_name: string,
        replaces_id: number,
        app_icon: string,
        summary: string,
        body: string,
        actions: string[],
        hints: Hints,
        time_out: number,
    ) {
        const acts: action[] = [];
        for (let i=0; i<actions.length; i+=2) {
            if (actions[i+1] !== '') {
                acts.push({
                    label: actions[i+1],
                    id: actions[i],
                });
            }
        }

        const id = replaces_id || this._idCount++;
        const urgency = _URGENCY[hints['urgency']?.unpack() || 1];
        const date = new Date();
        const notification: Notification = {
            id,
            appName: app_name,
            appId: hints['desktop-entry']?.unpack() || '',
            appIcon: app_icon,
            summary,
            body,
            actions: acts,
            urgency,
            time: { hour: date.getHours(), minute: date.getMinutes() },
            image:
                this._parseImage(`${summary}${id}`, hints['image-data']) ||
                this._isFile(app_icon),
        };

        this._notifications.set(notification.id, notification);

        if (!this._dnd) {
            this._popups.set(notification.id, notification);
            if (urgency !== 'critical') {
                timeout(
                    time_out > 0 ? time_out : this._timeout,
                    () => {
                        if (!this._popups.has(id))
                            return;

                        this._popups.delete(notification.id);
                        this._sync();
                    },
                );
            }
        }

        this._sync();
        return notification.id;
    }

    CloseNotification(id: number) {
        if (!this._notifications.has(id))
            return;

        this._dbus.emit_signal('NotificationClosed', GLib.Variant.new('(uu)', [id, 2]));
        this._notifications.delete(id);
        this._popups.delete(id);
        this._sync();
    }

    InvokeAction(id: number, actionId: string) {
        if (!this._notifications.has(id))
            return;

        this._dbus.emit_signal('ActionInvoked', GLib.Variant.new('(us)', [id, actionId]));
        this._notifications.delete(id);
        this._popups.delete(id);
        this._sync();
    }

    GetCapabilities() {
        return ['actions', 'body', 'icon-static', 'persistence'];
    }

    GetServerInformation() {
        return new GLib.Variant('(ssss)', [
            pkg.name,
            'Aylur',
            pkg.version,
            '1.2',
        ]);
    }

    _register() {
        Gio.bus_own_name(
            Gio.BusType.SESSION,
            'org.freedesktop.Notifications',
            Gio.BusNameOwnerFlags.NONE,
            (connection: Gio.DBusConnection) => {
                this._dbus = Gio.DBusExportedObject.wrapJSObject(NotificationIFace, this);
                this._dbus.export(connection, '/org/freedesktop/Notifications');
            },
            null,
            () => {
                print('Another Notification Daemon is already running!');
            },
        );
    }

    _filterName(name: string) {
        return NOTIFICATIONS_CACHE_PATH +
            '/' +
            name.replace(/[\ \,\*\?\"\<\>\|\#\:\?\/\!\']/g, '') +
            '.png';
    }

    _readFromFile() {
        try {
            const file = Gio.File.new_for_path(NOTIFICATIONS_CACHE_PATH+'/notifications.json');
            const [, contents] = file.load_contents(null);
            const json = JSON.parse(new TextDecoder('utf-8').decode(contents)) as { notifications: Notification[] };
            json.notifications.forEach(n => {
                if (n.id > this._idCount)
                    this._idCount = n.id+1;

                this._notifications.set(n.id, n);
            });
        } catch (error) {
            print('There were no cached notifications found');
        }
    }

    _isFile(path: string) {
        return GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
    }

    _parseImage(name: string, image_data?: GLib.Variant<'(iiibiiay)'>) {
        if (!image_data)
            return null;

        ensureCache();
        const fileName = this._filterName(name);
        const image = image_data.recursiveUnpack();
        const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
            image[6],
            GdkPixbuf.Colorspace.RGB,
            image[3],
            image[4],
            image[0],
            image[1],
            image[2],
        );

        const output_stream =
            Gio.File.new_for_path(fileName)
            .replace(null, false, Gio.FileCreateFlags.NONE, null);

        pixbuf.save_to_streamv(output_stream, 'png', null, null, null);
        output_stream.close(null);

        return fileName;
    }

    _sync() {
        const notifications = [];
        for (const [, notification] of this._notifications)
            notifications.push(notification);

        ensureCache();
        writeFile(JSON.stringify({ notifications }, null, 2), NOTIFICATIONS_CACHE_PATH+'/notifications.json');
        this.emit('changed');
    }
}

export default class Notifications {
    static { Service.export(this, 'Notifications'); }
    static _instance: NotificationsService;

    static connect(widget: Gtk.Widget, callback: () => void) {
        Service.ensureInstance(Notifications, NotificationsService);
        Notifications._instance.listen(widget, callback);
    }

    static clear() {
        Service.ensureInstance(Notifications, NotificationsService);
        Notifications._instance.Clear();
    }

    static invoke(id: number, action: string) {
        Service.ensureInstance(Notifications, NotificationsService);
        Notifications._instance.InvokeAction(id, action);
    }

    static close(id: number) {
        Service.ensureInstance(Notifications, NotificationsService);
        Notifications._instance.CloseNotification(id);
    }

    static toggleDND() {
        Service.ensureInstance(Notifications, NotificationsService);
        Notifications._instance.toggleDND();
    }

    static dismiss(id: number) {
        Service.ensureInstance(Notifications, NotificationsService);
        Notifications._instance.dismiss(id);
    }

    static get dnd() {
        Service.ensureInstance(Notifications, NotificationsService);
        return Notifications._instance._dnd;
    }

    static get popups() {
        Service.ensureInstance(Notifications, NotificationsService);
        return Notifications._instance._popups;
    }

    static get notifications() {
        Service.ensureInstance(Notifications, NotificationsService);
        return Notifications._instance._notifications;
    }
}